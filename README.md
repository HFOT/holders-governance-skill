# Holders' Governance Skill / 研ぎ澄ませるための情報

本物を見極めるには、それに見合った情報がいる。

情報は公開されている。ただ、読めない。どこにあるのかも分からない。
そういう情報を探して、読める形にして置いてある一枚もの。日英バイリンガル。

**https://hfot.github.io/holders-governance-skill/**

---

## 置いてあるもの

### 実測 — 公開データを測った結果

| | |
|---|---|
| [DRep Governance Terminal](https://hfot.github.io/drep-terminal-v6/) | DRep の投票力・委任者構成・資金流入出・集中度を、公開オンチェーンデータから毎日更新する |
| [Catalyst Japan](https://hfot.github.io/Catalyst-Japan/) | 日本の提案130件を金額・分野・進捗で並べ替える。F2 から F14、採択額 21.6M ₳ |
| [Relay Health Ranking](https://hfot.github.io/cardano-relay-health/) | 1,282プールのリレーを6軸で採点。届かないことは停止の証明ではない、と書き添えたうえで |
| [SPO Onchain Alive](https://hfot.github.io/spo-onchain-alive/) | Relay Health の6軸と委任者の数を、そのプールだけの質量と運動として描く。数字は実測値そのままで、変わるのは描き方だけ |
| [One Wallet, Two Delegations](https://hfot.github.io/cardano-two-delegations/) | ステーキング委任と DRep 委任の差を、シミュレーションで確かめる |

### 道具とモデル — 実測ではないもの

| | |
|---|---|
| [Space Translate](https://hfot.github.io/space-translate/app.html) | 分からない言語の音声を、その場で字幕にして翻訳する。ブラウザ内 Whisper、APIキー不要 |
| [The Decentralization Spiral](https://hfot.github.io/cardano-spiral/) | 現状のモデルを AI に生成させた一枚もの。**実測ではなく解釈**であり、意図的に辛口に振ってある |

実測とそれ以外は、ページ上でも分けて表示している。AI が生成したものを測定値と同格に並べない。

## 編集方針

思考の流動性と、真贋の持続可能性。

- 最終的に判断するのは、読み手自身の思考
- 誰かを非難するためではない
- 可視化され、多くの人が確認し、行動できる。そのフローが将来の価値を左右する

## 構成

```
index.html      本体（単一ファイル・ビルド不要）
flow.js         背景の描画エンジン（WebGL2・依存ライブラリなし）
shots/          各ページのスクリーンショット（日英2枚ずつ）
```

`index.html` を編集して push すれば、GitHub Pages に数十秒で反映される。

### 背景について

`flow.js` は技法の異なる5系統を持ち、右下のボタンで切り替えられる。選択は localStorage に保存される。

| | 技法 |
|---|---|
| Silk | GPGPU パーティクル。83,000点の座標を float テクスチャに置き、curl noise とアトラクタで移流。フィードバックバッファで軌跡を残す |
| Contour | 粒子を使わない。動くスカラー場の等値線をフラグメントシェーダで `fwidth` によりアンチエイリアス描画 |
| Ink | 流体。染料テクスチャを curl 速度場でセミラグランジュ移流。ping-pong、半解像度 |
| Rays | 一点から出る曲線群。各線を三次ベジエで分割し、頂点シェーダで光の頭を外へ走らせる。動いているのは幾何ではなく光 |
| Lattice | 線分プリミティブ。格子をノイズで3D変位させ `GL_LINES` で描画 |

WebGL2 が無い、幅1000px未満、`prefers-reduced-motion` のいずれかに該当する場合は canvas を生成せず、マークアップ内の SVG 流線180本にフォールバックする。

### 言語

両言語をマークアップに同居させ、ルートの `[data-lang]` 属性で出し分ける。
スクリプトが動かない場合は日本語が表示される。スクリーンショットも言語に追従する。

---

*HFOT® / 2026*
