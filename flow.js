/* ============================================================
   flow.js — realtime background art, desktop only.

   Four systems, deliberately built on different techniques so
   they read as different art rather than as settings of one
   effect. They share a palette, a left hand scrim and the way
   scrolling pushes them back, and nothing else.

     silk     GPGPU particles. 83k positions live in a float
              texture, advected by curl noise plus a pull toward
              a cycling attractor. Feedback buffer for trails.
     contour  No particles. A fragment shader draws the level
              sets of a drifting scalar field as hairlines,
              antialiased with fwidth.
     ink      A fluid. A dye texture is advected each frame by a
              curl velocity field, semi Lagrangian, with a soft
              source at the node. Ping pong, half resolution.
     lattice  Line primitives. A grid of segments is displaced
              in 3D by noise and drawn with GL_LINES.

   Falls back silently on narrow viewports, without WebGL2,
   without float render targets, or under reduced motion; the
   SVG streamlines in the markup stay visible in those cases.

   API, present only once it is actually running:
     window.CardanoFlow.presets -> [{id,label}, ...]
     window.CardanoFlow.set(i) / .current()
   ============================================================ */
(function () {
  'use strict';

  var HOST = document.querySelector('.art') || document.querySelector('.field');
var FIELD = document.querySelector('.field') || HOST;
  if (!HOST) return;
  if (!window.matchMedia('(min-width: 1000px)').matches) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var canvas = document.createElement('canvas');
  canvas.className = 'flow';
  canvas.setAttribute('aria-hidden', 'true');

  var gl = canvas.getContext('webgl2', {
    alpha: false, antialias: false, depth: false, stencil: false,
    powerPreference: 'high-performance'
  });
  if (!gl) return;
  if (!gl.getExtension('EXT_color_buffer_float')) return;

  /* ---------- helpers ---------- */
  function compile(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('[flow]', gl.getShaderInfoLog(sh)); return null;
    }
    return sh;
  }
  function program(vs, fs) {
    var a = compile(gl.VERTEX_SHADER, vs), b = compile(gl.FRAGMENT_SHADER, fs);
    if (!a || !b) return null;
    var p = gl.createProgram();
    gl.attachShader(p, a); gl.attachShader(p, b); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn('[flow]', gl.getProgramInfoLog(p)); return null;
    }
    p.u = {};
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var info = gl.getActiveUniform(p, i);
      p.u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
    }
    return p;
  }
  function tex(w, h, internal, format, type, filter) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    var f = filter || gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function fbo(t) {
    var f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return f;
  }
  function clearFbo(f) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /* ---------- shared glsl ---------- */
  var QUAD_VS = [
    '#version 300 es',
    'const vec2 P[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));',
    'out vec2 vUv;',
    'void main(){ vec2 p = P[gl_VertexID]; vUv = p * 0.5 + 0.5;',
    '             gl_Position = vec4(p, 0.0, 1.0); }'
  ].join('\n');

  var NOISE = [
    'vec3 hash3(vec3 p){',
    '  p = vec3(dot(p, vec3(127.1, 311.7,  74.7)),',
    '           dot(p, vec3(269.5, 183.3, 246.1)),',
    '           dot(p, vec3(113.5, 271.9, 124.6)));',
    '  return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;',
    '}',
    'float gnoise(vec3 p){',
    '  vec3 i = floor(p), f = fract(p);',
    '  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);',
    '  return mix(mix(mix(dot(hash3(i + vec3(0,0,0)), f - vec3(0,0,0)),',
    '                     dot(hash3(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),',
    '                 mix(dot(hash3(i + vec3(0,1,0)), f - vec3(0,1,0)),',
    '                     dot(hash3(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),',
    '             mix(mix(dot(hash3(i + vec3(0,0,1)), f - vec3(0,0,1)),',
    '                     dot(hash3(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),',
    '                 mix(dot(hash3(i + vec3(0,1,1)), f - vec3(0,1,1)),',
    '                     dot(hash3(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y), u.z);',
    '}',
    'vec3 potential(vec3 p){',
    '  return vec3(gnoise(p),',
    '              gnoise(p + vec3( 31.4,  17.2,   9.1)),',
    '              gnoise(p + vec3( -7.3,  45.6,  22.8)));',
    '}',
    'vec3 curl(vec3 p){',
    '  const float e = 0.13;',
    '  vec3 p0 = potential(p);',
    '  vec3 px = potential(p + vec3(e, 0.0, 0.0));',
    '  vec3 py = potential(p + vec3(0.0, e, 0.0));',
    '  vec3 pz = potential(p + vec3(0.0, 0.0, e));',
    '  return vec3((py.z - p0.z) - (pz.y - p0.y),',
    '              (pz.x - p0.x) - (px.z - p0.z),',
    '              (px.y - p0.y) - (py.x - p0.x)) / e;',
    '}'
  ].join('\n');

  var PALETTE = [
    'const vec3 C1 = vec3(0.239, 0.482, 1.000);',
    'const vec3 C2 = vec3(0.129, 0.831, 0.761);',
    'const vec3 C3 = vec3(0.545, 0.424, 1.000);',
    'vec3 ramp(float t){',
    '  t = clamp(t, 0.0, 1.0);',
    '  return mix(mix(C1, C3, smoothstep(0.0, 0.62, t)), C2, smoothstep(0.6, 1.0, t));',
    '}'
  ].join('\n');

  /* ---------- common passes ---------- */
  var pDecay = program(QUAD_VS, [
    '#version 300 es', 'precision highp float;',
    'in vec2 vUv; out vec4 frag;',
    'uniform sampler2D uSrc; uniform float uKeep;',
    'void main(){ frag = vec4(texture(uSrc, vUv).rgb * uKeep, 1.0); }'
  ].join('\n'));

  var pPresent = program(QUAD_VS, [
    '#version 300 es', 'precision highp float;',
    'in vec2 vUv; out vec4 frag;',
    'uniform sampler2D uSrc; uniform float uGain;',
    'void main(){',
    '  vec3 c = texture(uSrc, vUv).rgb * uGain;',
    '  c = c / (c + vec3(0.72));',
    '  frag = vec4(vec3(0.0235, 0.0275, 0.0392) + c * smoothstep(0.06, 0.46, vUv.x), 1.0);',
    '}'
  ].join('\n'));
  if (!pDecay || !pPresent) return;

  /* ============================================================
     SILK — GPGPU particles
     ============================================================ */
  var SIDE = 288, COUNT = SIDE * SIDE;

  var SHAPES = [
    'vec3 sFunnel(float u, float v, float T){',
    '  float a = u * 6.28318; float t = pow(v, 1.35); float r = t * 1.05;',
    '  return vec3(1.15 - t * 2.75, sin(a) * r, cos(a) * r * 0.62);',
    '}',
    'vec3 sTorus(float u, float v, float T){',
    '  float a = u * 6.28318; float b = v * 6.28318 + T * 0.35;',
    '  float R = 0.86, r = 0.30 + 0.06 * sin(T * 0.7);',
    '  return vec3((R + r * cos(b)) * cos(a) * 0.9,',
    '              (R + r * cos(b)) * sin(a), r * sin(b) * 1.5);',
    '}',
    'vec3 sRibbon(float u, float v, float T){',
    '  float x = mix(-1.65, 1.35, u);',
    '  float tw = sin(u * 5.4 + T * 0.42);',
    '  float w  = (v - 0.5) * (0.34 + 0.5 * (1.0 - u));',
    '  return vec3(x, tw * 0.62 + w * cos(u * 8.0 + T * 0.3),',
    '                 w * 2.1 * sin(u * 8.0 + T * 0.3) + tw * 0.22);',
    '}'
  ].join('\n');

  var pSim = program(QUAD_VS, [
    '#version 300 es', 'precision highp float;',
    'in vec2 vUv; out vec4 outPos;',
    'uniform sampler2D uPos; uniform float uTime, uDt; uniform vec3 uW;',
    NOISE, SHAPES,
    'void main(){',
    '  vec4 s = texture(uPos, vUv);',
    '  vec3 p = s.xyz; float age = s.w;',
    '  float u = vUv.x, v = vUv.y;',
    '  vec3 tgt = uW.x * sFunnel(u,v,uTime) + uW.y * sTorus(u,v,uTime) + uW.z * sRibbon(u,v,uTime);',
    '  vec3 flow = curl(p * 1.15 + vec3(0.0, 0.0, uTime * 0.09));',
    '  p += ((tgt - p) * 1.55 + flow * 0.42) * uDt;',
    '  age += uDt;',
    '  float life = 5.0 + fract(sin(u * 91.7 + v * 47.3) * 4371.13) * 5.0;',
    '  if (age > life){ p = tgt; age = 0.0; }',
    '  outPos = vec4(p, age);',
    '}'
  ].join('\n'));

  var pSeed = program(QUAD_VS, [
    '#version 300 es', 'precision highp float;',
    'in vec2 vUv; out vec4 outPos;', SHAPES,
    'void main(){ outPos = vec4(sFunnel(vUv.x, vUv.y, 0.0),',
    '  fract(sin(vUv.x * 91.7 + vUv.y * 47.3) * 4371.13) * 6.0); }'
  ].join('\n'));

  var pPoint = program([
    '#version 300 es', 'precision highp float;',
    'uniform sampler2D uPos; uniform float uAspect, uTime, uScroll, uDpr; uniform int uSide;',
    'out vec3 vCol;', PALETTE,
    'void main(){',
    '  ivec2 tc = ivec2(gl_VertexID % uSide, gl_VertexID / uSide);',
    '  vec4 s = texelFetch(uPos, tc, 0); vec3 p = s.xyz;',
    '  float ry = uTime * 0.075 + uScroll * 1.25, rx = -0.16 + uScroll * 0.30;',
    '  float cy = cos(ry), sy = sin(ry);',
    '  p = vec3(p.x*cy + p.z*sy, p.y, -p.x*sy + p.z*cy);',
    '  float cx = cos(rx), sx = sin(rx);',
    '  p = vec3(p.x, p.y*cx - p.z*sx, p.y*sx + p.z*cx);',
    '  float z = p.z + 3.05 + uScroll * 2.4;',
    '  vec2 ndc = p.xy / z * 1.85;',
    '  ndc.x = ndc.x * 0.88 / uAspect * 1.9 + 0.28; ndc.y *= 0.88;',
    '  gl_Position = vec4(ndc, 0.0, 1.0);',
    '  gl_PointSize = max(1.0, 1.35 * uDpr * (2.6 / z));',
    '  float fade = smoothstep(6.4, 1.6, z) * smoothstep(0.0, 0.25, s.w);',
    '  vCol = ramp(float(tc.y) / float(uSide)) * fade * 0.15;',
    '}'
  ].join('\n'), [
    '#version 300 es', 'precision highp float;',
    'in vec3 vCol; out vec4 frag;',
    'void main(){ frag = vec4(vCol * smoothstep(0.5, 0.06, length(gl_PointCoord - 0.5)), 1.0); }'
  ].join('\n'));

  /* ============================================================
     CONTOUR — level sets of a drifting field, no particles
     ============================================================ */
  var pContour = program(QUAD_VS, [
    '#version 300 es', 'precision highp float;',
    'in vec2 vUv; out vec4 frag;',
    'uniform float uTime, uAspect, uScroll;',
    NOISE, PALETTE,
    'void main(){',
    '  vec2 p = (vUv - vec2(0.66, 0.5)) * vec2(uAspect, 1.0) * (2.3 + uScroll * 1.5);',
    '  float T = uTime * 0.055;',
    '  float f = gnoise(vec3(p * 0.85, T))',
    '          + 0.48 * gnoise(vec3(p * 1.9 + 11.0, T * 1.4))',
    '          + 0.22 * gnoise(vec3(p * 4.1 - 5.0, T * 2.1));',
    '  f -= 0.34 * length(p * vec2(0.72, 1.0));',
    '  float g = f * 30.0;',
    '  float w = max(fwidth(g), 1e-4);',
    '  float line = 1.0 - smoothstep(0.0, 1.35, abs(fract(g) - 0.5) / w);',
    '  float fall = smoothstep(2.35, 0.15, length(p * vec2(0.78, 1.0)));',
    '  vec3 col = ramp(0.5 + 0.5 * sin(f * 2.4 + 1.2));',
    '  frag = vec4(col * line * fall * 0.62, 1.0);',
    '}'
  ].join('\n'));

  /* ============================================================
     INK — dye advected by a curl velocity field
     ============================================================ */
  var pInkStep = program(QUAD_VS, [
    '#version 300 es', 'precision highp float;',
    'in vec2 vUv; out vec4 frag;',
    'uniform sampler2D uDye; uniform float uTime, uDt, uAspect;',
    NOISE, PALETTE,
    'void main(){',
    '  vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);',
    '  vec3 v = curl(vec3(q * 1.7, uTime * 0.12));',
    '  vec2 uv = vUv - v.xy * uDt * 0.115;',
    '  uv.x += uDt * 0.032;',                    /* a slow drift off the node */
    '  vec3 d = texture(uDye, uv).rgb * 0.9968;',
    '  vec2 node = vec2(0.885, 0.5);',
    '  float r = length((vUv - node) * vec2(uAspect, 1.0));',
    '  float src = exp(-r * 15.0);',
    '  d += ramp(0.5 + 0.5 * sin(uTime * 0.28 + r * 4.0)) * src * uDt * 5.4;',
    '  frag = vec4(min(d, vec3(4.0)), 1.0);',
    '}'
  ].join('\n'));

  var pInkDraw = program(QUAD_VS, [
    '#version 300 es', 'precision highp float;',
    'in vec2 vUv; out vec4 frag;',
    'uniform sampler2D uDye;',
    'void main(){ frag = vec4(texture(uDye, vUv).rgb * 0.9, 1.0); }'
  ].join('\n'));

  /* ============================================================
     LATTICE — a displaced grid drawn with line primitives
     ============================================================ */
  var LN = 74;                                    /* grid resolution */
  var LSEG = (LN - 1) * LN * 2;                   /* horizontal + vertical */
  var pLine = program([
    '#version 300 es', 'precision highp float;',
    'uniform float uTime, uAspect, uScroll; uniform int uN;',
    'out vec3 vCol;', NOISE, PALETTE,
    'vec3 latt(vec2 g, float T){',
    '  vec2 uv = g;',
    '  float x = mix(-1.55, 1.30, uv.x);',
    '  float z = (uv.y - 0.5) * 2.1;',
    '  float y = gnoise(vec3(uv * 3.1, T * 0.22)) * 0.52',
    '          + gnoise(vec3(uv * 6.7 + 4.0, T * 0.31)) * 0.18;',
    '  return vec3(x, y, z);',
    '}',
    'void main(){',
    '  int id = gl_VertexID; int seg = id / 2; int e = id % 2;',
    '  int h = (uN - 1) * uN;',
    '  ivec2 a, b;',
    '  if (seg < h){ int r = seg / (uN - 1), c = seg - r * (uN - 1);',
    '                a = ivec2(c, r); b = ivec2(c + 1, r); }',
    '  else       { int s = seg - h; int c = s / (uN - 1), r = s - c * (uN - 1);',
    '                a = ivec2(c, r); b = ivec2(c, r + 1); }',
    '  ivec2 gi = (e == 0) ? a : b;',
    '  vec2 g = vec2(gi) / float(uN - 1);',
    '  vec3 p = latt(g, uTime);',
    '  float ry = 0.42 + uTime * 0.045 + uScroll * 1.0, rx = -0.42 + uScroll * 0.3;',
    '  float cy = cos(ry), sy = sin(ry);',
    '  p = vec3(p.x*cy + p.z*sy, p.y, -p.x*sy + p.z*cy);',
    '  float cx = cos(rx), sx = sin(rx);',
    '  p = vec3(p.x, p.y*cx - p.z*sx, p.y*sx + p.z*cx);',
    '  float z = p.z + 3.0 + uScroll * 2.2;',
    '  vec2 ndc = p.xy / z * 1.9;',
    '  ndc.x = ndc.x * 0.9 / uAspect * 1.9 + 0.30; ndc.y *= 0.9;',
    '  gl_Position = vec4(ndc, 0.0, 1.0);',
    '  float fade = smoothstep(6.0, 1.4, z);',
    '  vCol = ramp(g.y * 0.7 + p.y * 0.35 + 0.3) * fade * 0.085;',
    '}'
  ].join('\n'), [
    '#version 300 es', 'precision highp float;',
    'in vec3 vCol; out vec4 frag;',
    'void main(){ frag = vec4(vCol, 1.0); }'
  ].join('\n'));

  if (!pSim || !pSeed || !pPoint || !pContour || !pInkStep || !pInkDraw || !pLine) return;

  /* ---------- resources ---------- */
  var vao = gl.createVertexArray();
  var posT = [tex(SIDE, SIDE, gl.RGBA32F, gl.RGBA, gl.FLOAT),
              tex(SIDE, SIDE, gl.RGBA32F, gl.RGBA, gl.FLOAT)];
  var posF = [fbo(posT[0]), fbo(posT[1])], cur = 0;

  var accT = [null, null], accF = [null, null];   /* full res accumulation */
  var dyeT = [null, null], dyeF = [null, null];   /* half res dye */
  var W = 0, H = 0, DW = 0, DH = 0, DPR = 1;

  function sizeUp() {
    var r = HOST.getBoundingClientRect();
    DPR = Math.min(window.devicePixelRatio || 1, 1.5);
    var w = Math.max(2, Math.round(r.width * DPR));
    var h = Math.max(2, Math.round(r.height * DPR));
    if (w === W && h === H) return;
    W = w; H = h; DW = Math.max(2, w >> 1); DH = Math.max(2, h >> 1);
    canvas.width = W; canvas.height = H;
    canvas.style.width = r.width + 'px';
    canvas.style.height = r.height + 'px';
    for (var i = 0; i < 2; i++) {
      if (accT[i]) { gl.deleteTexture(accT[i]); gl.deleteFramebuffer(accF[i]); }
      accT[i] = tex(W, H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
      accF[i] = fbo(accT[i]); clearFbo(accF[i]);
      if (dyeT[i]) { gl.deleteTexture(dyeT[i]); gl.deleteFramebuffer(dyeF[i]); }
      dyeT[i] = tex(DW, DH, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
      dyeF[i] = fbo(dyeT[i]); clearFbo(dyeF[i]);
    }
  }

  function seedParticles() {
    gl.useProgram(pSeed); gl.bindVertexArray(vao);
    for (var i = 0; i < 2; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, posF[i]);
      gl.viewport(0, 0, SIDE, SIDE);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  /* ---------- systems ---------- */
  var wArr = [0, 0, 0];
  function silkWeights(t) {
    var HOLD = 13, x = (t / HOLD) % 3, i = Math.floor(x), f = x - i;
    var b = f < 0.72 ? 0 : (f - 0.72) / 0.28; b = b * b * (3 - 2 * b);
    wArr[0] = wArr[1] = wArr[2] = 0;
    wArr[i % 3] += 1 - b; wArr[(i + 1) % 3] += b;
    return wArr;
  }

  var SYS = [
    {
      id: 'silk', label: 'Silk', trail: true, keep: 0.947, gain: 1.0,
      draw: function (t, dt, scroll) {
        var w = silkWeights(t);
        gl.disable(gl.BLEND);
        gl.useProgram(pSim);
        gl.bindFramebuffer(gl.FRAMEBUFFER, posF[1 - cur]);
        gl.viewport(0, 0, SIDE, SIDE);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, posT[cur]);
        gl.uniform1i(pSim.u.uPos, 0);
        gl.uniform1f(pSim.u.uTime, t); gl.uniform1f(pSim.u.uDt, dt);
        gl.uniform3f(pSim.u.uW, w[0], w[1], w[2]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        cur = 1 - cur;

        gl.bindFramebuffer(gl.FRAMEBUFFER, accF[1]);
        gl.viewport(0, 0, W, H);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(pPoint);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, posT[cur]);
        gl.uniform1i(pPoint.u.uPos, 0);
        gl.uniform1f(pPoint.u.uAspect, W / H);
        gl.uniform1f(pPoint.u.uTime, t);
        gl.uniform1f(pPoint.u.uScroll, scroll);
        gl.uniform1f(pPoint.u.uDpr, DPR);
        gl.uniform1i(pPoint.u.uSide, SIDE);
        gl.drawArrays(gl.POINTS, 0, COUNT);
        gl.disable(gl.BLEND);
      }
    },
    {
      id: 'contour', label: 'Contour', trail: false, gain: 1.0,
      draw: function (t, dt, scroll) {
        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER, accF[1]);
        gl.viewport(0, 0, W, H);
        gl.useProgram(pContour);
        gl.uniform1f(pContour.u.uTime, t);
        gl.uniform1f(pContour.u.uAspect, W / H);
        gl.uniform1f(pContour.u.uScroll, scroll);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    },
    {
      id: 'ink', label: 'Ink', trail: false, gain: 0.5, dye: 0,
      draw: function (t, dt, scroll) {
        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER, dyeF[1 - this.dye]);
        gl.viewport(0, 0, DW, DH);
        gl.useProgram(pInkStep);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, dyeT[this.dye]);
        gl.uniform1i(pInkStep.u.uDye, 0);
        gl.uniform1f(pInkStep.u.uTime, t);
        gl.uniform1f(pInkStep.u.uDt, Math.min(dt, 0.02) * 60.0 / 60.0);
        gl.uniform1f(pInkStep.u.uAspect, W / H);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.dye = 1 - this.dye;

        gl.bindFramebuffer(gl.FRAMEBUFFER, accF[1]);
        gl.viewport(0, 0, W, H);
        gl.useProgram(pInkDraw);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, dyeT[this.dye]);
        gl.uniform1i(pInkDraw.u.uDye, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    },
    {
      id: 'lattice', label: 'Lattice', trail: true, keep: 0.72, gain: 1.0,
      draw: function (t, dt, scroll) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, accF[1]);
        gl.viewport(0, 0, W, H);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(pLine);
        gl.uniform1f(pLine.u.uTime, t);
        gl.uniform1f(pLine.u.uAspect, W / H);
        gl.uniform1f(pLine.u.uScroll, scroll);
        gl.uniform1i(pLine.u.uN, LN);
        gl.drawArrays(gl.LINES, 0, LSEG * 2);
        gl.disable(gl.BLEND);
      }
    }
  ];
  var sys = SYS[0];

  HOST.insertBefore(canvas, HOST.firstChild);
  FIELD.classList.add('has-flow');
  sizeUp();
  seedParticles();

  var last = 0, running = true, t0 = 0;

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    if (!t0) t0 = now;
    var t = (now - t0) / 1000;
    var dt = Math.min(0.033, last ? (now - last) / 1000 : 0.016);
    last = now;

    sizeUp();
    var scroll = Math.min(1, Math.max(0, window.scrollY / Math.max(1, window.innerHeight)));
    gl.bindVertexArray(vao);

    /* systems that keep a history start from the faded previous
       frame; the others paint a clean buffer every time */
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, accF[1]);
    gl.viewport(0, 0, W, H);
    if (sys.trail) {
      gl.useProgram(pDecay);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, accT[0]);
      gl.uniform1i(pDecay.u.uSrc, 0);
      gl.uniform1f(pDecay.u.uKeep, sys.keep);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    }

    sys.draw(t, dt, scroll);

    var tt = accT[0]; accT[0] = accT[1]; accT[1] = tt;
    var ff = accF[0]; accF[0] = accF[1]; accF[1] = ff;

    gl.disable(gl.BLEND);
    gl.useProgram(pPresent);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, accT[0]);
    gl.uniform1i(pPresent.u.uSrc, 0);
    gl.uniform1f(pPresent.u.uGain, sys.gain);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) running = false;
    else if (!running) { running = true; last = 0; requestAnimationFrame(frame); }
  });
  canvas.addEventListener('webglcontextlost', function (e) {
    e.preventDefault(); running = false; FIELD.classList.remove('has-flow');
  });

  window.CardanoFlow = {
    presets: SYS.map(function (s) { return { id: s.id, label: s.label }; }),
    current: function () { return SYS.indexOf(sys); },
    set: function (i) {
      if (i < 0 || i >= SYS.length || SYS[i] === sys) return;
      sys = SYS[i];
      clearFbo(accF[0]); clearFbo(accF[1]);
      clearFbo(dyeF[0]); clearFbo(dyeF[1]);
      if (sys.id === 'silk') seedParticles();
      return sys.id;
    }
  };

  requestAnimationFrame(frame);
})();
