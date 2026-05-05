# Movie Cut — 仕様書

## 概要

ブラウザ完結の動画分割・保存ツール。サーバーへのアップロード不要で、すべての処理をクライアント側で行う。

- URL: Vercel にデプロイ済み
- 単一ファイル構成: `index.html`（CSS・JS インライン）
- ライブラリ: `@ffmpeg/ffmpeg@0.11.6` + `@ffmpeg/core@0.11.0`（CDN 経由で動的ロード）

---

## ファイル構成

```
movie-cut/
├── index.html       # アプリ本体（CSS・JS すべてインライン）
├── favicon.svg      # ハサミ＋カットラインのアイコン
├── server.py        # ローカル開発用 HTTP サーバー（COOP/COEP ヘッダー付き）
├── vercel.json      # Vercel デプロイ設定（COOP/COEP ヘッダー）
├── sw.js            # Service Worker（レガシー、現在未使用）
└── AGENTS.md        # 本仕様書
```

---

## 技術スタック

| 項目 | 内容 |
|------|------|
| FFmpeg | `@ffmpeg/ffmpeg@0.11.6`（0.11.x 系の blob ワーカー方式） |
| FFmpeg Core | `@ffmpeg/core@0.11.0` |
| CDN | jsDelivr（プライマリ）→ unpkg（フォールバック） |
| COOP/COEP | `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: credentialless` |
| 理由 | SharedArrayBuffer を使うために必須 |

### CDN フォールバック

```js
const FFMPEG_CDN_CANDIDATES = [
  { script: 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js',
    core:   'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js' },
  { script: 'https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js',
    core:   'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js' },
];
```

### バージョンに関する注意

- `0.12.x` 系は CDN からのワーカー読み込みが COEP でブロックされるため使用不可
- `0.11.x` 系はワーカーを blob として内包するため問題なし

---

## レイアウト

### デスクトップ（768px 超）

```
┌──────────────────────────────┬─────────────┐
│           header             │   header    │
├──────────────────────────────┤             │
│           player             │   sidebar   │
├──────────────────────────────┤  (320px)    │
│          timeline            │             │
├──────────────────────────────┤             │
│          segments            │             │
└──────────────────────────────┴─────────────┘
```

```css
grid-template-rows: 48px 1fr 140px 300px;
grid-template-columns: 1fr var(--sidebar-w);  /* --sidebar-w: 320px */
```

サイドバーはリサイズハンドル（`#sidebar-resize-handle`）でドラッグ幅変更可能。

### モバイル（768px 以下）

```
┌────────────┐
│   header   │
├────────────┤
│   player   │
├────────────┤
│  timeline  │
├────────────┤
│  segments  │
├────────────┤
│   sidebar  │ ← 保存ボタンのみの細いバー
└────────────┘
```

- `overflow: auto; height: auto;` でスクロール可能
- ボリュームスライダー・タイムラインヒント・キーボードショートカット欄は非表示
- セグメントカード: 1列

---

## 状態変数

```js
let videoFile         = null;       // File オブジェクト
let videoDuration     = 0;          // 秒数
let splitPoints       = [];         // ソート済みの分割点（秒）配列
let ffmpeg            = null;       // FFmpeg インスタンス
let ffmpegReady       = false;
let isExporting       = false;
let selectedSegments  = new Set();  // エクスポート対象のセグメントインデックス
let excludedSegments  = new Set();  // カット除外セグメントのインデックス
let segmentPlayEnd    = null;       // 現在プレビュー中のセグメント終了時刻
let segmentNames      = {};         // index → カスタム名
let ffmpegInputName   = null;       // 現在 FS に書き込まれているファイル名

// スクラブ状態
let isScrubbing         = false;
let wasPlayingBeforeScrub = false;
let pendingScrubTime    = null;
let seekBusy            = false;

// マーカードラッグ状態
let draggingMarker = null;  // { el, index }
let dragStartX     = 0;
let dragStartTime  = 0;
```

---

## 機能仕様

### 動画の読み込み

- ドラッグ&ドロップ または「Browse file」ボタン
- 対応フォーマット: MP4, MKV, MOV, WebM, AVI など（ブラウザが再生できる形式）
- 2GB 超: ブロック（エラー表示）
- 500MB 超: 警告トースト表示して続行
- ファイル名をヘッダーに表示、「Change file」で別ファイルに切り替え

### 分割点の追加・削除

- `S` キー / `M` キー / ヘッダーの「Add Split」ボタン / コントロール内の「＋ Split」ボタン → 現在再生位置に分割点追加
- `Z` キー → 最後の分割点をアンドゥ
- 黄色いマーカー（▼）をドラッグして位置変更
- マーカーの `×` をクリックで削除

### シーク・再生

- スペースキー → 再生/一時停止
- `←` / `→` キー → ±0.1秒シーク
- タイムラインをクリック/ドラッグ → シーク
- タッチ操作でも同様（モバイル対応）
- スクラブ時: `fastSeek()` + `seeked` イベントでキュー管理してスムーズシーク

### タイムライン

- セグメントを色分けして表示（8色パレート循環）
- 除外セグメントはハッチパターン表示
- 選択セグメントは明るいボーダー＋高い透明度
- タイムラインバーをクリック → そのセグメントの選択をトグル
- タイムラインバーをドラッグ → シーク

### セグメント管理

| 操作 | 内容 |
|------|------|
| カードをクリック | 選択/解除（除外中は不可） |
| タイムラインバーをクリック | 選択/解除 |
| 名前入力欄 | ファイル名として使用される（保存時サニタイズ） |
| ▶ ボタン | セグメント先頭から再生 |
| ⏸ ボタン（再生中） | 一時停止（位置保持） |
| ▶ ボタン（一時停止中、青く明るい） | 再開 |
| ✕ ボタン | セグメントを除外（カット）← エクスポート対象から外れる |
| ↺ ボタン（除外中） | 除外を解除して復元 |
| 全選択 / 全解除 | すべてのセグメントを選択/解除 |

#### セグメントプレイボタンの状態

```
停止中:  ▶ (opacity: 0.7、青)
再生中:  ⏸ (opacity: 1.0、ピンク .segment-play-btn.playing)
一時停止: ▶ (opacity: 1.0、青 .segment-play-btn.paused)
```

### セグメント除外（カット）

- `excludedSegments` Set でインデックスを管理
- 除外されたセグメントは:
  - タイムラインでハッチパターン表示
  - カードに `.excluded` クラス付与
  - エクスポート時に自動スキップ
  - 選択不可
- 復元ボタン（↺）で除外を解除

```js
// エクスポート対象の絞り込み
const indices = [...selectedSegments]
  .filter(i => !excludedSegments.has(i))
  .sort((a, b) => a - b);
```

### エクスポート（保存）

- 選択済み（かつ未除外）セグメントを順番に処理
- FFmpeg で再エンコード（libx264 ultrafast + AAC）
  - ストリームコピーではなく再エンコードの理由: キーフレーム問題による黒画面・時間ずれを防ぐため
- ファイル名 = セグメント名（サニタイズ済み）+ `.mp4`
- 進捗バー: FS 書き込み → FFmpeg ログ解析 → ダウンロード
- 並列エクスポート不可（`isExporting` フラグで管理）

#### FFmpeg コマンド（再エンコード方式）

```js
await ffmpeg.run(
  '-ss', String(Math.max(0, start - 5)),  // 5秒前に高速入力シーク
  '-i', inputName,
  '-ss', String(start < 5 ? start : 5),   // 正確な出力シーク
  '-t', String(duration),
  '-c:v', 'libx264',
  '-preset', 'ultrafast',
  '-crf', '18',
  '-c:a', 'aac',
  '-b:a', '192k',
  outputName,
);
```

#### ファイル保存方法（優先順位）

1. `showSaveFilePicker`（File System Access API、デスクトップ Chrome/Edge）
2. `navigator.share({ files })`（iOS/Android のシェアシート）
3. `<a download>` クリック（フォールバック）

ObjectURL は 1000ms 後に revoke。

#### 入力ファイルのキャッシュ

FFmpeg FS への書き込みはファイルごとに 1 回のみ（`ffmpegInputName` で管理）。別ファイルに切り替えた場合は旧ファイルを `unlink` してから再書き込み。

---

## キーボードショートカット

| キー | 動作 |
|------|------|
| `Space` | 再生/一時停止 |
| `S` / `M` | 現在位置に分割点追加 |
| `←` | -0.1秒シーク |
| `→` | +0.1秒シーク |
| `Z` | 最後の分割点を削除（アンドゥ） |

テキスト入力中（セグメント名入力欄など）はショートカット無効化。

---

## セキュリティ

- ファイルサイズ制限: 2GB 超はブロック（クラッシュ防止）
- FFmpeg FS に書き込むファイル名をサニタイズ（英数字・ドット以外を `_` に置換）
- 出力ファイル名をサニタイズ（`/ \ : * ? " < > |` を `_` に置換）
- CDN フォールバックで単一障害点を排除
- COOP/COEP ヘッダーで SharedArrayBuffer を安全に使用

---

## ローカル開発

```bash
python3 server.py
# → http://localhost:8765 で起動（COOP/COEP ヘッダー付き）
```

`file://` では COOP/COEP が効かないため、必ず `http://` 経由でアクセスすること。

---

## Vercel デプロイ

`vercel.json` でヘッダー設定済み:

```json
{
  "headers": [{
    "source": "/(.*)",
    "headers": [
      { "key": "Cross-Origin-Opener-Policy",   "value": "same-origin"    },
      { "key": "Cross-Origin-Embedder-Policy",  "value": "credentialless" }
    ]
  }]
}
```

---

## カラーパレット（セグメント色）

```
0: #5b6af0 (青)
1: #f05b8a (ピンク)
2: #4caf7d (緑)
3: #f9c846 (黄)
4: #5bc8f0 (水色)
5: #c85bf0 (紫)
6: #f08c5b (オレンジ)
7: #5bf0b8 (エメラルド)
```

---

## 既知の制約

- FFmpeg.wasm は処理が遅い（1分のクリップで30秒〜数分）
- ブラウザのメモリに動画をまるごと読み込むため、非常に大きなファイルはメモリ不足になる可能性あり
- `showSaveFilePicker` は iOS Safari 未対応（代わりにシェアシートを使用）
- キーボードショートカットはデスクトップのみ有効
