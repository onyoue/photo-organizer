# Cullback アーキテクチャ

このドキュメントは Cullback のソースコード構成を読むときの地図です。
何が何を呼んでいて、どこにデータが保存されるか。各ディレクトリの責務と、
代表的なオペレーションでのデータの流れを把握できれば、コードを開いたときに
迷わなくなります。

機能仕様は [REQUIREMENTS.md](./REQUIREMENTS.md) を参照。

---

## 全体像

3つのサブシステムが連動します:

```
┌─────────────────────────────────────────┐
│    Cullback Desktop (Tauri 2.x)         │
│                                         │
│  ┌─────────────────┐  ┌──────────────┐  │
│  │  React + TS UI  │◄─┤ Rust commands│  │
│  │  (src/)         │  │ (src-tauri/) │  │
│  └─────────────────┘  └──────┬───────┘  │
│           ▲                  │          │
│           │                  ▼          │
│           │         ┌────────────────┐  │
│           │         │ Local FS       │  │
│           │         │ - 写真         │  │
│           │         │ - .photoorg/   │  │
│           │         │ - sidecar JSON │  │
│           │         └────────────────┘  │
└───────────┼─────────────────────────────┘
            │ HTTP (Bearer ADMIN_TOKEN)
            ▼
┌─────────────────────────────────────────┐
│   Cloudflare Worker (gallery-worker/)   │
│                                         │
│   ┌────────────┐    ┌────────────┐      │
│   │     R2     │    │     KV     │      │
│   │ 写真本体   │    │ メタデータ │      │
│   │            │    │ + 集計     │      │
│   └────────────┘    └────────────┘      │
└─────────────────────────────────────────┘
            ▲
            │ HTTPS (no auth)
            │
        モデルのスマホ
```

- **デスクトップ**: 写真の選別・整理・現像連携・投稿管理がメイン。
  ギャラリーシェアは Worker への HTTP 経由でアップロード／フィードバック取得。
- **Worker**: 時間制限付きギャラリーをホスト。モバイルレビュー HTML を動的に
  サーブし、フィードバック (OK/NG/FAV) を KV に記録。
- **モバイル**: ブラウザだけで動く。認証なしの URL 直リンク。

---

## デスクトップ: フロントエンド (`src/`)

React + TypeScript。Tauri の `invoke()` で Rust コマンドを呼び、結果でステートを
更新する典型的な構造。

```
src/
├── App.tsx          # トップレベル: 状態管理 + ルーティング + ショートカット
├── main.tsx         # エントリ。webview デフォルト挙動の抑制
├── App.css          # 全部のスタイル（小さいので分割せずワンファイル）
│
├── components/
│   ├── ThumbnailGrid.tsx     # 仮想スクロール付きサムネイル一覧
│   ├── BundleTile.tsx        # 1バンドルのタイル（フラグ・投稿アイコン重畳）
│   ├── PreviewPane.tsx       # 大きいプレビュー領域、Fit/100% 切替
│   ├── DetailPanel.tsx       # 右ペイン: ファイル一覧・操作ボタン・タグ・投稿
│   ├── PostsSection.tsx      # 投稿レコードの追加・編集
│   ├── TagsSection.tsx       # タグ編集
│   ├── SettingsDialog.tsx    # 設定 (RAW現像アプリ / Gallery URL / Admin token)
│   ├── ShareDialog.tsx       # ギャラリー作成・アップロード
│   ├── GalleriesDialog.tsx   # 既存ギャラリー一覧・フィードバック取り込み・削除
│   └── CheatsheetOverlay.tsx # `?` キーで出るショートカット一覧
│
├── types/
│   ├── bundle.ts    # BundleSummary, BundleFile, FolderIndex
│   ├── sidecar.ts   # BundleSidecar, PostRecord, Flag
│   ├── gallery.ts   # GalleryRecord, GalleryFeedbackEntry, GalleryStats
│   ├── settings.ts  # AppSettings, GallerySettings, Decision
│   ├── thumb.ts     # ThumbState (ready/loading/error/none)
│   └── preview.ts   # プレビューサイズ等
│
└── utils/
    ├── filter.ts        # フィルタモード (FilterMode) と applyFilter
    ├── flagPatch.ts     # 集約フラグ計算（feedback_by_model → flag の reduce）
    ├── format.ts        # formatSize 等
    ├── path.ts          # パスユーティリティ
    ├── preview.ts       # previewVariants（バンドル内の表示候補）
    ├── selection.ts     # 範囲選択 (Shift+クリック等)
    ├── shortcuts.ts     # キーバインディング定義
    ├── tags.ts          # タグ正規化
    └── url.ts           # URL バリデーション
```

### 主要な状態 (App.tsx)

`App.tsx` が大半の状態を持つ "container" コンポーネント。主要なものは:

| state | 役割 |
|---|---|
| `index: FolderIndex \| null` | 開いているフォルダのスキャン結果（バンドル一覧 + メタ） |
| `thumbs: Record<string, ThumbState>` | バンドル ID → サムネイル状態 |
| `selectedIds: Set<string>` | 複数選択中のバンドル ID 群 |
| `activeId: string \| null` | フォーカス中の1バンドル |
| `tileLabel: TileLabel` | サムネイルサイズ（XS〜XL） |
| `filterMode / filterTag` | フィルタ状態 |
| `appSettings` | 設定（RAW developer 一覧、Gallery URL/Token） |

主要な副作用の入口:
- `pickAndOpenFolder()` → `open_folder` Tauri コマンド呼び → `index` 更新 →
  `generate_thumbnails` を発火 → 完了イベントで `thumbs` 更新
- `applyGalleryFeedback()` → 各バンドルに対する `set_bundle_flag` 呼び出し +
  `index` 内の対応する BundleSummary もインメモリで更新（`flagPatch.ts`）

---

## デスクトップ: バックエンド (`src-tauri/src/`)

Rust 側は **commands → core → models** の3層。

```
src-tauri/src/
├── main.rs                # `cullback_lib::run()` 呼ぶだけ
├── lib.rs                 # tauri::Builder + invoke_handler 登録
├── error.rs               # AppError / AppResult
│
├── commands/              # Tauri から呼べる #[tauri::command] 群（薄い）
│   ├── folder.rs          # open_folder
│   ├── thumbnail.rs       # ensure_thumbnail / generate_thumbnails
│   ├── fileops.rs         # trash_bundle / move_bundle / copy_bundle / open_path
│   ├── sidecar.rs         # get_bundle_sidecar / set_bundle_rating / flag / tags
│   ├── settings.rs        # get_app_settings / save_app_settings / cycle_active_raw_developer
│   └── gallery.rs         # share_gallery / fetch_gallery_feedback / list / delete
│                          # + get_gallery_stats / cancel_share_gallery
│
├── core/                  # ビジネスロジック（ファイル I/O・並列処理・HTTP）
│   ├── scanner.rs         # フォルダスキャン → FolderIndex の生成
│   ├── thumbnail.rs       # サムネイル生成（image + webp、rayon 並列）
│   ├── fileops.rs         # ゴミ箱／移動／コピー（サイドカーも一緒に追従）
│   ├── sidecar.rs         # サイドカー JSON の読み書き + apply_*（rating/flag/tags）
│   ├── index_cache.rs     # `.photoorg/index.json` 読み書き（フォルダの再スキャン回避）
│   ├── app_settings.rs    # 設定 JSON の読み書き
│   ├── gallery_client.rs  # Worker 向け HTTP クライアント（reqwest）
│   └── gallery_store.rs   # 作成済みギャラリー一覧 (galleries.json) の読み書き
│   APP_DIR = ".photoorg"  # 写真フォルダ内の隠しディレクトリ名
│
└── models/                # serde で JSON 化される構造体
    ├── bundle.rs          # BundleSummary, BundleFile, FolderIndex, FileRole
    ├── sidecar.rs         # BundleSidecar, Flag, PostRecord, Platform, PostBy
    ├── gallery.rs         # GalleryRecord, GalleryPhotoRecord
    └── settings.rs        # AppSettings, GallerySettings, Decision, RawDeveloper
```

### 設計原則

- **commands** は引数バリデーションと `core` の関数呼び出しだけ。長くなったら
  core に分離。
- **core** はステートレスな関数群（あるいは小さなクライアント struct）。
  Tauri の `AppHandle` が必要なものだけ commands から渡す。
- **models** は serde 用の純粋なデータ型のみ。ビジネスロジックは持たない。
- **`AppDataDir`** (`%APPDATA%\com.photoorg.app\`) には:
  - `settings.json` - アプリ全体の設定
  - `galleries.json` - 作成したギャラリーの履歴
- **写真フォルダ内** には:
  - `<base_name>.photoorg.json` - バンドル単位のサイドカー（フラグ・タグ・投稿）
  - `.photoorg/index.json` - フォルダスキャン結果のキャッシュ
  - `.photoorg/thumbs/<hash>.webp` - サムネイルキャッシュ

---

## Cloudflare Worker (`gallery-worker/`)

写真ホスト + モバイルレビュー UI + フィードバック収集。

```
gallery-worker/src/
├── index.ts        # ルーター: /admin/* は Bearer 認証、それ以外は公開
├── admin.ts        # 写真家用エンドポイント (PUT/POST /admin/<gid>...)
├── public.ts       # 公開エンドポイント (GET /<gid>, /<gid>/zip, POST /feedback)
├── html.ts         # モバイルレビュー HTML を1つの文字列で返す（CSS/JS インライン）
├── zip.ts          # STORE-method ZIP ストリーム生成（Worker CPU 制約対策）
├── types.ts        # GalleryMeta, FeedbackResponse, StatsTotals
└── util.ts         # KV/R2 キーヘルパー、json/text レスポンスヘルパー
```

詳細は [gallery-worker/CLOUDFLARE.md](./gallery-worker/CLOUDFLARE.md)。
何故その設計なのかは特に「ZIP の STORE 方式」と「stats:totals の incremental 集計」が
読みどころ。

---

## 代表的なデータフロー

### A. フォルダを開く

```
[UI] Open Folder ボタン
  └─→ commands::folder::open_folder
        └─→ core::scanner::scan_folder
              ├─ index_cache::read（あればフォルダ mtime チェック）
              ├─ ファイル列挙 + バンドル束ね
              ├─ 各バンドルの sidecar::read で メタを反映
              └─ index_cache::write に書き戻し
        ←─ FolderIndex
[UI] index ステート更新 → ThumbnailGrid 描画
[UI] generate_thumbnails 発火（バックグラウンド）
        └─→ core::thumbnail で rayon 並列生成、完了ごとにイベント emit
```

### B. ギャラリーをシェアする

```
[UI] ShareDialog → 「シェア開始」
  └─→ commands::gallery::share_gallery
        ├─ create_gallery → Worker PUT /admin/<gid>（KV にメタ保存）
        ├─ 各 photo: upload_photo → Worker PUT /admin/<gid>/photos/<pid>
        │   （R2 にバイナリ保存、KV stats:totals に r2_bytes 加算）
        ├─ finalize → Worker POST /admin/<gid>/finalize
        └─ gallery_store::upsert（GalleryRecord をローカル保存）
  ←─ { gid, url }
```

中止ボタンが押されたら `commands::gallery::cancel_share_gallery` が
`ShareCancelFlag: AtomicBool` を true に倒し、上記ループの先頭でチェックされて
ループ抜け + Worker で partial gallery を delete。

### C. モデルがレビューする

```
[スマホ] GET /<gid>  → Worker
  └─ KV から GalleryMeta + decisions を取り出して renderGalleryHtml
  ←─ <html> （CSS/JS インライン、画像は <img src="/<gid>/p/<pid>"> で別 GET）

[スマホ] OK/NG/FAV タップ → POST /<gid>/feedback
  └─ KV: feedback:<gid>:<pid> = "ok" | "ng" | "fav"

[スマホ] 「全部 DL」または選択 DL
  ├─ 単写真: <img> がもう取得済み → Web Share API でフォトライブラリへ
  └─ ZIP: GET /<gid>/zip → ReadableStream で R2 から STORE-method ZIP 生成
```

### D. フィードバックを取り込む

```
[UI] 📥 ボタン → fetchFeedbackForCurrentFolder
  └─ gallery_store::read で全ギャラリー取得 → source_folder で当該フォルダのもの絞り込み
     各 g に対して:
        └─→ commands::gallery::fetch_gallery_feedback(gid)
              └─ Worker GET /admin/<gid>/feedback で decisions 取得
              └─ ローカルの GalleryRecord.last_decisions / last_fetched_at に書き戻し
              └─ pid → bundle_id 解決して GalleryFeedbackEntry を返す
        └─ applyGalleryFeedback(gid, entries, g.model_name)
              ├─ バンドル単位に集約（FAV > NG > OK > clear）
              └─ commands::sidecar::set_bundle_flag(folder, bundles, flag, modelName)
                    ├─ core::sidecar::apply_flag で feedback_by_model に書き込み + 集約 flag 再計算
                    └─ patch_cache_for_bundles で .photoorg/index.json も同期
[UI] index ステートも flagPatch.patchBundleFlag で同期更新
```

---

## 拡張するときの目安

| やりたいこと | どこを触る |
|---|---|
| 新しい画像形式に対応したい | `core/scanner.rs` の拡張子分類 + `core/thumbnail.rs` のデコーダ |
| 投稿先プラットフォームを追加 | `models/sidecar.rs::Platform` 列挙、UI の `BundleTile` のグリフマップ |
| ギャラリーに新エンドポイント追加 | `gallery-worker/src/admin.ts` or `public.ts` + `core/gallery_client.rs` の対応メソッド + `commands/gallery.rs` のラッパ |
| サイドカーに新フィールド追加 | `models/sidecar.rs::BundleSidecar` + 必要なら `models/bundle.rs::BundleSummary` への射影、scanner.rs での読み出し、TS 側 `types/sidecar.ts` も同期 |
| 新しいフィルタモード | `utils/filter.ts::FilterMode` + `matchMode` |
| 新しいキーボードショートカット | `utils/shortcuts.ts` + App.tsx の handler |
