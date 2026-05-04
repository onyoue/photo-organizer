# Cullback — 要件定義・設計書

> ポートレート撮影会後の写真整理と、SNS投稿管理に特化した軽量デスクトップアプリ。

---

## 1. プロジェクト概要

### 1.1 目的

撮影会で数百枚規模で発生する RAW+JPG ペアの選別・整理・投稿管理を高速に行うための、Windows / macOS 対応デスクトップアプリ。

### 1.2 既存ツールではダメな理由

- **Windows Explorer / Finder**: RAW と JPG が別ファイルとして表示され、選別・移動・削除が煩雑。
- **Lightroom 等のカタログ型 DAM**: カタログのインポートが重く、起動も遅い。フォルダベースの自然な操作と乖離する。
- **Adobe Bridge / FastStone 等のビューア**: 投稿管理機能がない。SNS 投稿先の追跡ができない。

### 1.3 本アプリの差別化ポイント

1. **ファイル束ね操作**: RAW+JPG（+現像設定+現像後ファイル）を 1 単位として扱う。
2. **軽量・高速起動**: Tauri ベースで Electron 比 1/10 以下のメモリ・バイナリサイズ。
3. **SNS 投稿管理**: X / Instagram / note への投稿先を写真に紐付け、サムネイルにアイコンオーバーレイで一覧可視化。
4. **モデル投稿の追跡**: ポートレート撮影で、モデル側アカウントが投稿した URL を後から追記可能。
5. **フォルダベース**: カタログ DB を持たず、メタデータは写真フォルダ内のサイドカーファイルに保存。フォルダ移動・別 PC 共有でメタデータも追従する。

---

## 2. 技術スタック

| レイヤ | 採用技術 | 理由 |
|---|---|---|
| アプリフレームワーク | **Tauri 2.x** | Electron 比で軽量。別プロジェクト（RAW 現像アプリ）と統一。 |
| UI | **React + TypeScript** | 既存知見の活用。 |
| 仮想スクロール | **`@tanstack/react-virtual`** | 数千枚のサムネイルグリッドでも軽快。Grid 対応済み。 |
| バックエンド言語 | **Rust** | ファイル走査・サムネイル生成・並列処理が高速。 |
| 並列処理 | **`rayon`** | サムネイル生成の CPU コア数並列化。 |
| 画像処理 | **`image` クレート** + **`webp` クレート** | サムネイル縮小と WebP エンコード。 |
| RAW プレビュー抽出 | **`little_exif`** + 自前ロジック | フル RAW デコードを避け、埋め込みプレビュー JPG を抽出。 |
| EXIF 読み取り | **`kamadak-exif`** | EXIF 撮影日時・カメラ情報の取得。 |
| シリアライズ | **`serde` + `serde_json`** | サイドカー JSON の読み書き。 |
| ID 生成 | **`ulid` クレート** | バンドル ID・投稿レコード ID。時系列ソート可能。 |

**採用しないもの**:

- SQLite 等の DB: サイドカーファイル方式を採用したため不要。
- フル RAW デコードライブラリ（`rawloader` 等）: サムネイル用途では埋め込みプレビューで十分。将来 100% 表示で必要になったら追加検討。

---

## 3. 想定ワークフロー

```
[1] 撮影会で数百枚撮影 (RAW + JPG)
       ↓
[2] アプリでフォルダを開く
       ↓
[3] サムネイル一覧で全体把握
       ↓
[4] 失敗写真を Fit / 100% 表示でチェックして削除
       ↓
[5] 良い写真に pick フラグ・レーティング付与
       ↓
[6] pick した写真を select/ サブフォルダへ移動
       ↓
[7] 各写真を別アプリ (RAW 現像) で開いて現像
       ↓
[8] 現像後 JPG だけを delivery/ サブフォルダへコピー
       ↓
[9] X / Instagram / note に投稿（外部アプリで実施）
       ↓
[10] 投稿 URL を本アプリに記録
       ↓
[11] 後日、モデル側投稿を見つけたら URL を追記
```

---

## 4. 機能要件

### 4.1 Phase 1: 整理ツールとして最低限動く

優先度: **必須**。これが動かないと意味がない。

- **F1.1** フォルダを開く（パス指定 / フォルダ選択ダイアログ）。
- **F1.2** フォルダ内のファイルを走査し、basename ベースでバンドル化して一覧表示。
- **F1.3** サムネイルグリッド表示（仮想スクロール）。サイズはユーザーが調整可能（小・中・大の 3 段階で十分）。
- **F1.4** バンドル選択時、画面の別エリアで Fit 表示（画面に収まるサイズで全体表示）。
- **F1.5** Fit 表示と 100% 表示の高速切替。100% 表示時は前後のバンドルに移動しても**同じピクセル位置**を維持（ピント確認のため）。
- **F1.6** バンドル単位での操作:
  - 削除（OS のゴミ箱へ移動）
  - フォルダ移動
  - フォルダコピー
  - 「現像後 JPG のみ」を別フォルダへコピー
- **F1.7** 別アプリで開く（"Open with..." 機能。RAW のみ / JPG のみ / バンドル全体を渡せる）。
- **F1.8** キーボードショートカット（[6.2 節](#62-キーボードショートカット仕様)参照）。

### 4.2 Phase 2: 高速化

優先度: **必須**。Phase 1 完成直後に着手。

- **F2.1** サムネイル永続キャッシュ（`.photoorg/thumbs/<hash>.webp`）。
- **F2.2** フォルダインデックス（`.photoorg/index.json`）による起動高速化。
- **F2.3** 並列サムネイル生成 + 進捗イベント通知。
- **F2.4** バックグラウンドでのキャッシュ生成中もユーザー操作をブロックしない。

### 4.3 Phase 3: 投稿管理

優先度: **本アプリの差別化機能**。

- **F3.1** 投稿レコードの追加 UI（プラットフォーム選択 + URL 貼り付け）。
- **F3.2** サムネイルへの投稿先アイコンオーバーレイ表示。
- **F3.3** 投稿 URL のクリックで OS の既定ブラウザを起動。
- **F3.4** 「モデル投稿」のフラグ表示（破線アイコン等で自分の投稿と区別）。
- **F3.5** 詳細パネルで投稿履歴の一覧・編集・削除。

### 4.4 Phase 4: 追加価値（任意）

優先度: **後回しで OK**。

- **F4.1** レーティング（★0〜5）と pick/reject フラグ。
- **F4.2** タグ管理（モデル名・撮影地など）。
- **F4.3** フィルタ・検索（pick のみ表示、未投稿のみ表示、特定モデルのみ等）。
- **F4.4** 撮影セッション概念（フォルダを「2025-04-12 渋谷モデル A 撮影会」のように意味付け）。

---

## 5. 非機能要件

### 5.1 性能目標

| 操作 | 目標値 | 備考 |
|---|---|---|
| アプリ起動 | < 1 秒 | Tauri なら現実的。 |
| 500 枚フォルダの初回読み込み (キャッシュなし) | < 30 秒 | プレビュー抽出方式 + 並列処理で達成可能。 |
| 同フォルダの 2 回目以降の起動 | < 2 秒 | インデックスファイルから読み込み。 |
| サムネイル ↔ Fit 表示切替 | < 100ms | 体感で「即座」と感じる閾値。 |
| 100% 表示への切替 | < 300ms | JPG 直読みで実現。 |
| メモリ使用量 (500 枚表示時) | < 500MB | 仮想スクロールと LRU キャッシュで制御。 |

### 5.2 動作環境

- Windows 10/11 (x64)
- macOS 12+ (Intel / Apple Silicon)

### 5.3 対応 RAW フォーマット (プレビュー抽出)

優先順位:
1. **Leica DNG** (SL2-S 等) — DNG は標準仕様、プレビュー抽出が容易。
2. **Fujifilm RAF** — Fuji の独自形式、プレビュー位置をハンドルする。
3. **Pentax PEF/DNG** (K3-III Monochrome 等) — DNG ならば 1 と同じ扱いで OK。
4. **その他** (Sony ARW、Canon CR3 等) — 将来対応。

---

## 6. UI 仕様

### 6.1 画面構成

```
┌─────────────────────────────────────────────────────┐
│ [Folder: /path/to/shoot]   [≡] [□]    [Settings]    │ ← トップバー
├──────────┬──────────────────────────┬───────────────┤
│          │                          │               │
│ Folder   │   Thumbnail Grid         │ Detail Panel  │
│  Tree    │   (virtual scroll)       │  - Filename   │
│          │                          │  - EXIF       │
│ select/  │   [📷][📷][📷][📷]       │  - Posts      │
│ delivery/│   [📷][📷][📷][📷]       │  - [Add post] │
│          │   [📷][📷][📷][📷]       │               │
│          │                          │               │
├──────────┴──────────────────────────┴───────────────┤
│ Selected: DSC_0123 (4/500)  [Fit: ◉]  [100%: ○]     │ ← ステータスバー
└─────────────────────────────────────────────────────┘
```

選別モード時は**プレビューエリアを大きく取る**ためにサイドパネルを折りたためる。

### 6.2 キーボードショートカット仕様

ユーザー優先度に基づく設計（**1: サムネイル↔Fit 切替を最優先**）:

| キー | 動作 | フェーズ |
|---|---|---|
| **Space** | サムネイル表示 ↔ Fit 表示の切替（最重要） | Phase 1 |
| **F** | 100% 表示の切替 (Fit と相互トグル) | Phase 1 |
| **← / →** | 前 / 次のバンドルへ移動 (100% 時はピクセル位置を維持) | Phase 1 |
| **Shift + ← / →** | 範囲選択 | Phase 1 |
| **Delete** | 選択中バンドルを削除 (ゴミ箱へ) | Phase 1 |
| **Ctrl/Cmd + C / V** | コピー / ペースト | Phase 1 |
| **M** | 移動先フォルダを選んで移動 | Phase 1 |
| **0–5** | レーティング (0=なし, 1–5=★1–★5) | Phase 4 |
| **P** | pick フラグ | Phase 4 |
| **X** | reject フラグ | Phase 4 |
| **Enter** | 詳細パネルで投稿追加ダイアログを開く | Phase 3 |

100% 表示時の左右移動で「同じピクセル位置を維持」は、選別の本命機能。**画像中心からの相対オフセット**を保持し、次画像に切り替えても同じ部分を表示する。

---

## 7. データ設計

### 7.1 サイドカーファイル方針

メタデータは写真フォルダ内に保存する。これにより:
- フォルダごと別 PC へコピーするとメタデータも自動的に追従。
- アプリをアンインストールしてもユーザーデータが消えない。
- バックアップ戦略がシンプル（写真フォルダのバックアップ = メタデータのバックアップ）。

ただし**「数百枚分の JSON を毎回読む」のは遅い**ため、フォルダ単位のインデックスファイルでキャッシュする 2 階層構造を採用する。

### 7.2 ファイル構成

```
shoot_2026-04-12/
├── DSC_0123.DNG               # RAW
├── DSC_0123.JPG               # JPG (撮って出し)
├── DSC_0123.photoorg.json     # サイドカー (バンドル単位)
├── DSC_0124.RAF
├── DSC_0124.JPG
├── DSC_0124.photoorg.json
├── ...
└── .photoorg/                 # 隠しフォルダ (アプリ管理領域)
    ├── index.json             # フォルダ単位インデックス (高速起動用キャッシュ)
    ├── thumbs/                # サムネイルキャッシュ
    │   ├── 01jk8x...webp
    │   └── ...
    └── settings.json          # フォルダごとの設定 (任意)
```

### 7.3 サイドカーファイルスキーマ (`<basename>.photoorg.json`)

```typescript
interface BundleSidecar {
  version: 1;
  bundle_id: string;            // ULID. 永続的な識別子
  base_name: string;            // "DSC_0123"
  rating?: 0 | 1 | 2 | 3 | 4 | 5;
  flag?: "pick" | "reject" | null;
  tags?: string[];              // ["model:saki", "shibuya"]
  posts: PostRecord[];
  created_at: string;           // ISO 8601
  updated_at: string;           // ISO 8601
}

interface PostRecord {
  id: string;                   // ULID
  platform: "x" | "instagram" | "note" | "other";
  url: string;
  posted_at?: string;           // ISO 8601 (任意、不明なら省略)
  by: "self" | "model" | "other";
  posted_by_handle?: string;    // モデル投稿時のアカウント名 "@saki_model"
  note?: string;                // 自由記述メモ
}
```

**設計判断**:
- ファイルが存在しないバンドル = 「メタデータなし」。デフォルト値で扱う。
- 投稿が空配列のサイドカーは作成しない（不要なファイル散乱を防ぐ）。
- 書き込み時は**アトミックに**: 一時ファイル → rename。

### 7.4 インデックスファイルスキーマ (`.photoorg/index.json`)

```typescript
interface FolderIndex {
  version: 1;
  scanned_at: string;           // ISO 8601
  folder_mtime: string;         // 親フォルダの mtime (整合性チェック用)
  bundles: BundleSummary[];
}

interface BundleSummary {
  bundle_id: string;
  base_name: string;
  files: BundleFile[];
  thumbnail_path?: string;      // .photoorg/thumbs/<hash>.webp の絶対パス
  rating?: number;
  flag?: "pick" | "reject" | null;
  has_posts: boolean;
  post_platforms: string[];     // ["x", "instagram"] サムネイルアイコン表示用
  has_model_post: boolean;
  exif_capture_time?: string;   // ソート用
}

interface BundleFile {
  role: "raw" | "jpeg" | "sidecar" | "developed" | "unknown";
  path: string;                 // フォルダからの相対パス
  size: number;
  mtime: string;
}
```

### 7.5 整合性管理

- アプリ起動時 / フォルダオープン時に、フォルダの `mtime` と `index.json` の `folder_mtime` を比較。
- 不一致なら**差分スキャン**: 新規ファイルだけ走査、削除されたファイルだけインデックスから除去。
- ユーザー操作で「再スキャン」を明示的にトリガー可能。

### 7.6 ファイル束ねロジック

**基本ルール**: basename（拡張子を除いたファイル名）が同じファイルは 1 バンドル。

```
DSC_0123.DNG  ─┐
DSC_0123.JPG   ├─ Bundle: "DSC_0123"
DSC_0123.XMP  ─┘

DSC_0123_edit.JPG  ─── Bundle: "DSC_0123_edit" (別バンドル)
```

**Phase 1 では「完全一致のみ」**で実装する。`DSC_0123_edit.JPG` のような派生ファイルとの自動紐付けは Phase 4 以降の拡張機能とし、ユーザーが明示的に「現像後フォルダ」を別途管理する想定。

**ファイル種別の分類**:

```rust
fn classify_file(path: &Path) -> FileRole {
    match path.extension()?.to_str()?.to_lowercase().as_str() {
        "dng" | "raf" | "pef" | "arw" | "cr3" | "nef" | "raw" => FileRole::Raw,
        "jpg" | "jpeg" => FileRole::Jpeg,
        "xmp" | "pp3" | "dop" | "rwl" => FileRole::Sidecar,
        _ => FileRole::Unknown,
    }
}
```

---

## 8. アーキテクチャ

### 8.1 レイヤ構成

```
┌─────────────────────────────────────────────┐
│  React UI (TypeScript)                      │
│  - ThumbnailGrid                             │
│  - PreviewPanel (Fit / 100%)                 │
│  - DetailPanel (Posts)                       │
│  - useStore (Zustand 等の軽量ストア)         │
└────────────────┬────────────────────────────┘
                 │ Tauri IPC (commands + events)
┌────────────────▼────────────────────────────┐
│  Rust Backend                                │
│  - scanner   : フォルダ走査・バンドル化       │
│  - thumbnail : プレビュー抽出・WebP生成       │
│  - sidecar   : JSON 読み書き                 │
│  - index     : インデックスファイル管理       │
│  - fileops   : 移動・コピー・削除             │
└─────────────────────────────────────────────┘
```

### 8.2 Tauri Command 設計

**設計原則**: IPC コストを意識し、粒度を適切に保つ。サムネイル画像データは IPC で送らず、ファイルパスを返して `convertFileSrc` でフロントから直接参照する。

```rust
// フォルダを開いてバンドル一覧を返す (キャッシュ済みは即座に返す)
#[tauri::command]
async fn open_folder(path: String) -> Result<FolderIndex, AppError>;

// 単一バンドルの詳細 (サイドカー + EXIF)
#[tauri::command]
async fn get_bundle_detail(folder: String, bundle_id: String) -> Result<BundleDetail, AppError>;

// サイドカーの保存
#[tauri::command]
async fn save_bundle_metadata(folder: String, bundle_id: String, data: BundleSidecar) -> Result<(), AppError>;

// バンドル単位のファイル操作
#[tauri::command]
async fn move_bundles(bundle_ids: Vec<String>, src: String, dst: String) -> Result<(), AppError>;

#[tauri::command]
async fn copy_bundles(bundle_ids: Vec<String>, src: String, dst: String, files_only: Option<Vec<String>>) -> Result<(), AppError>;

#[tauri::command]
async fn delete_bundles(bundle_ids: Vec<String>, folder: String) -> Result<(), AppError>;

// 別アプリで開く
#[tauri::command]
async fn open_with_default(paths: Vec<String>) -> Result<(), AppError>;

// 100% 表示用のフルサイズ JPG パス取得
#[tauri::command]
async fn get_preview_path(folder: String, bundle_id: String, preview_type: PreviewType) -> Result<String, AppError>;

// 投稿 URL をブラウザで開く
#[tauri::command]
async fn open_url(url: String) -> Result<(), AppError>;
```

### 8.3 イベント (Rust → React)

```typescript
// バックグラウンドでサムネイル生成完了
"thumbnail-ready": { bundle_id: string, thumbnail_path: string }

// スキャン進捗
"scan-progress": { current: number, total: number }

// ファイル操作完了
"fileop-complete": { operation: string, success: number, failed: number }

// エラー
"error": { message: string, detail?: string }
```

### 8.4 サムネイル生成パイプライン

```
[フォルダオープン]
    ↓
[インデックスファイル読込]
    ↓
[キャッシュ済みサムネイル → 即座に表示]
    ↓
[未生成バンドル → バックグラウンドキューへ]
    ↓
[rayon で並列処理]
    ├─ JPG あり → image::open → 縮小 → WebP 保存
    └─ RAW のみ → 埋め込みプレビュー抽出 → 縮小 → WebP 保存
    ↓
[1枚生成ごとに emit("thumbnail-ready")]
    ↓
[フロントが <img src> を更新]
```

### 8.5 100% 表示のピクセル位置維持

選別作業の中核機能。実装方針:

1. ユーザーが画像中心からのオフセット `(dx, dy)` を持つ（パン操作で更新）。
2. 次画像に切り替え時、画像サイズの中心からの相対座標として `(dx, dy)` を再適用。
3. 画像サイズが異なる場合は中心基準で計算（同じ撮影セッションなら通常同じサイズ）。

```typescript
// 状態管理
const [pixelOffset, setPixelOffset] = useState({ dx: 0, dy: 0 });

// 表示時
const imgX = (containerWidth - imgWidth) / 2 + pixelOffset.dx;
const imgY = (containerHeight - imgHeight) / 2 + pixelOffset.dy;
```

---

## 9. 段階的開発計画

各 Phase は独立してリリース可能なまとまりとする。

### Phase 1: コア整理機能 (目安: 2〜3 週末)

**ゴール**: 撮影会後の選別作業がこのツールだけで完結する。

- フォルダオープン・走査・バンドル化
- サムネイルグリッド (キャッシュなし、毎回生成でも OK)
- Fit / 100% 表示と切替
- 100% 表示でのピクセル位置維持
- バンドル単位の移動・削除・コピー
- 別アプリ起動
- キーボードショートカット (Phase 1 範囲)

### Phase 2: 高速化 (目安: 1〜2 週末)

**ゴール**: 500 枚フォルダで「サクサク」と言える体感。

- サムネイル永続キャッシュ
- フォルダインデックスファイル
- 並列生成と進捗イベント
- 整合性チェック (mtime 比較)

### Phase 3: 投稿管理 (目安: 2〜3 週末)

**ゴール**: SNS 投稿の追跡が本アプリで完結する。

- サイドカーファイルの読み書き
- 投稿レコード追加 / 編集 / 削除 UI
- サムネイルへのアイコンオーバーレイ
- モデル投稿の区別表示
- ブラウザ起動による投稿閲覧

### Phase 4: 追加価値 (任意)

レーティング・タグ・フィルタ・セッション管理。利用しながら要望を見て実装。

---

## 10. リスクと対応

| リスク | 影響 | 対応 |
|---|---|---|
| RAW プレビュー抽出が機種依存で動かない | サムネイル生成が遅い / 失敗 | Phase 1 では JPG 優先で動かし、RAW のみケースは段階的対応。失敗時はプレースホルダ表示。 |
| サイドカーファイルが多すぎてフォルダが煩雑 | ユーザー体験悪化 | `.photoorg.json` 拡張子で OS の Hidden フラグを立てる検討。または `.photoorg/sidecars/` への集約オプション。 |
| 大量サムネイルでメモリ枯渇 | クラッシュ | 仮想スクロール + LRU キャッシュ (上限 200 枚程度をメモリに保持)。 |
| ファイル移動中の中断 | 不整合 | 操作開始前にトランザクション ID を発行し、各ファイル操作を idempotent に実装。失敗時はロールバック。 |
| 別 PC への移行時の bundle_id 重複 | データ破損 | bundle_id は ULID で衝突確率が極めて低い。さらにフォルダ + base_name でユニーク制約。 |

---

## 11. ディレクトリ構成案

```
cullback/
├── src/                       # React フロントエンド
│   ├── components/
│   │   ├── ThumbnailGrid.tsx
│   │   ├── PreviewPanel.tsx
│   │   ├── DetailPanel.tsx
│   │   └── PostEditor.tsx
│   ├── hooks/
│   │   ├── useFolderState.ts
│   │   └── useKeyboard.ts
│   ├── store/
│   │   └── appStore.ts        # Zustand 推奨
│   ├── types/
│   │   └── bundle.ts          # Rust 側と整合する型定義
│   ├── utils/
│   │   └── pixelOffset.ts
│   ├── App.tsx
│   └── main.tsx
├── src-tauri/                 # Rust バックエンド
│   ├── src/
│   │   ├── main.rs
│   │   ├── commands/
│   │   │   ├── mod.rs
│   │   │   ├── folder.rs
│   │   │   ├── bundle.rs
│   │   │   ├── fileops.rs
│   │   │   └── url.rs
│   │   ├── core/
│   │   │   ├── mod.rs
│   │   │   ├── scanner.rs     # フォルダ走査・バンドル化
│   │   │   ├── thumbnail.rs   # サムネイル生成
│   │   │   ├── preview.rs     # RAW プレビュー抽出
│   │   │   ├── sidecar.rs     # JSON 読み書き
│   │   │   ├── index.rs       # インデックスファイル
│   │   │   └── fileops.rs     # 移動・コピー・削除
│   │   ├── models/
│   │   │   ├── mod.rs
│   │   │   ├── bundle.rs
│   │   │   └── post.rs
│   │   └── error.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── package.json
├── vite.config.ts
├── tsconfig.json
└── README.md
```

---

## 12. 開発の進め方

Claude Code に本ドキュメントを渡し、以下の順で開発を進める想定:

1. **環境セットアップ**: Tauri + React + TypeScript プロジェクトの初期化。
2. **Phase 1.1**: `scanner.rs` (フォルダ走査・バンドル化) と最小 UI でファイル一覧を表示。
3. **Phase 1.2**: `thumbnail.rs` でサムネイル生成 (まずは JPG のみ)。
4. **Phase 1.3**: グリッド UI と仮想スクロール。
5. **Phase 1.4**: Fit / 100% 表示とキーボード操作。
6. **Phase 1.5**: ファイル操作 (移動・削除・コピー)。
7. 以降 Phase 2, 3, 4 を順次追加。

各ステップで動作するものを作ってから次へ進む。完璧主義より、**動くものを段階的に育てる**方針を取る。

---

## 13. 用語

- **バンドル (Bundle)**: 拡張子違いで同じ basename を持つファイル群を 1 単位として扱ったもの。本アプリの操作の基本単位。
- **サイドカー (Sidecar)**: 写真ファイルと並んで配置される、メタデータ用 JSON ファイル。
- **インデックス (Index)**: フォルダ内全バンドルの要約をまとめた、起動高速化用キャッシュファイル。
- **pick / reject**: 選別フラグ。pick = 採用候補、reject = 削除候補。
- **撮って出し JPG**: カメラが RAW と同時に出力する JPG。現像前の状態。
- **現像後 JPG**: 別アプリで RAW から現像した結果の JPG。本アプリでは命名規則で区別する想定。
