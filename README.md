# Cullback

ポートレート撮影会のための、写真選別 (culling) + モデルレビュー連携デスクトップアプリ。

撮影会で数百枚規模の RAW+JPG を高速に整理し、現像済み JPG をモデルにブラウザ経由で
レビューしてもらい、その OK/NG/FAV 判定を再びアプリのフラグに自動同期する、という
「撮影〜納品」の往復ループを1つのアプリで完結させます。

---

## できること

### 写真整理（撮影会後の選別）

- **バンドル単位の表示**: `DSC_0123.ARW` + `DSC_0123.JPG` + `DSC_0123_edit.JPG`
  + サイドカー (`.xmp`/`.pp3`/`.dop`/`.json`) を **1単位として表示**。RAW と JPG が
  別ファイルとして散らばらない。
- **高速サムネイル**: 全バンドルを WebP サムネイルに事前生成し、`.photoorg/thumbs/`
  に永続キャッシュ。数千枚でも仮想スクロールで軽快。
- **フラグとレーティング**: ★1〜5 のレーティング、★FAV / ✓OK / ✕NG の3値フラグ、
  自由タグをバンドルに付与。
- **フィルタとセレクト**: フラグ・レーティング・タグ・「投稿済みかどうか」で
  サムネイル一覧を絞り込み。
- **複数選択 + 一括操作**: Shift+クリックで範囲選択、Ctrl+クリックで個別選択、
  選択したバンドルをまとめてゴミ箱・移動・コピー。
- **RAW 現像連携**: 任意の現像アプリ（自作の Rust 製アプリ、Lightroom、ART 等）を
  「Open RAW」ボタンに登録、複数登録時はホットキーで切替。

### 投稿管理（SNS 投稿先の追跡）

- **投稿レコード**: バンドル単位で「X / Instagram / note のどこにいつ誰
  （自分 or モデル）が投稿したか」の URL リストを記録。
- **タイル可視化**: サムネイルにプラットフォーム別のアイコンを重ねて、ひと目で
  「投稿済み・未投稿・モデルが投稿」を把握。

### ギャラリーシェア（モデルレビュー連携）

撮影会後、モデルに**スマホで写真を見て OK/NG/FAV を付けてもらう**ためのループ。

- **ワンクリックでシェア URL 発行**: 選択したバンドルの現像済み JPG を Cloudflare
  R2 にアップロードし、`https://cullback.<your-subdomain>.workers.dev/<gid>` の
  共有リンクを発行。
- **スマホ最適化のレビュー画面**: モデルはブラウザを開くだけで、認証なしで
  写真をスワイプ・タップして OK/NG/FAV を選べる。
- **デフォルト判定**: 「全部 OK 前提で NG だけ付けてもらう」運用と、「全部 NG 前提で
  OK だけ付けてもらう」運用を選択可能。
- **ZIP / Photo Library 直接保存**: モデル側からの一括 DL や、Web Share API による
  iOS/Android のフォトライブラリへの直接保存。
- **フィードバック取り込み**: アプリ側で 📥 ボタン1つで現在のフォルダ向けの
  フィードバックを全部取り込み、各バンドルの flag に自動反映。
- **モデル別仕分け**: シェア時に「モデル名」を付けると、ペア撮影でも各モデルの
  判定が混ざらず別バケットで保存される。
- **閲覧専用リンク**: 自分用にギャラリーを見直すための、判定ボタン非表示の URL を
  別途発行。
- **R2 無料枠の使用状況**: シェア画面に「R2: 1.2 / 10 GB」のバーを表示、
  80% で警告。

### その他

- **フォルダベース**: カタログ DB なし。メタデータは写真フォルダ内に
  `.photoorg.json` サイドカーとして保存される。**フォルダごと別 PC に
  コピーするだけでメタデータも追従する**。
- **Tauri 製で軽量**: Electron 比でメモリもバイナリサイズも 1/10 以下。

---

## クイックスタート

### 必要なもの

- Node.js 20+
- Rust toolchain (stable)
- Cloudflare アカウント（ギャラリーシェア機能を使う場合）

### ローカル開発

```sh
git clone <this repo>
cd cullback

# 依存解決
npm install

# 開発モードで起動（Rust + フロントエンドが両方ビルドされる）
npm run tauri dev
```

### 本番ビルド

```sh
npm run tauri build
# → src-tauri/target/release/cullback.exe
# → src-tauri/target/release/bundle/msi/Cullback_*.msi （Windows）
# → src-tauri/target/release/bundle/dmg/Cullback_*.dmg （macOS）
```

### ギャラリーシェア機能のセットアップ

ギャラリー機能は Cloudflare 上で動く別 Worker (`gallery-worker/`) が必要です。
詳細は [gallery-worker/SETUP.md](./gallery-worker/SETUP.md)。

```sh
cd gallery-worker
npm install
npx wrangler login
npx wrangler r2 bucket create cullback
npx wrangler kv namespace create GALLERY_KV     # 出力された id を wrangler.toml に貼る
npx wrangler secret put ADMIN_TOKEN             # 適当なランダム文字列
npx wrangler deploy
```

デプロイ後、アプリの 設定 → Gallery に Worker URL と ADMIN_TOKEN を入力すれば
シェア機能が有効になります。

---

## 他の人に使ってもらう場合

このリポジトリは現在「自分でビルドして使う」前提です。他の人（写真家仲間など）に
配布する場合の留意点をまとめます。

### アプリ本体の配布

| 配布規模 | やること | コスト |
|---|---|---|
| 友人数人 | `npm run tauri build` で出来た msi/dmg を渡す。未署名なので Windows SmartScreen 警告は出る（「詳細情報→実行」で起動可能） | 0円 |
| 知人〜公開 | 上 + コード署名（Windows EV cert ≈ ¥3万/年 / macOS Developer ID ≈ ¥1.4万/年） | 年額数万円 |
| 不特定多数 | 上 + 自動アップデータ（`tauri-plugin-updater`）+ プライバシポリシ等 | 開発工数大 |

GitHub Actions で push 時にビルドして Releases にアップロードするフローを組むと
楽。現状のリポジトリにはまだ未整備。

### ギャラリーシェア機能のセットアップ（各ユーザーごと）

ギャラリーシェア機能は **各ユーザーが自分の Cloudflare アカウント** を持つ必要が
あります（写真は各自の R2 に保存される）。手順は
[gallery-worker/SETUP.md](./gallery-worker/SETUP.md)。

- **必要なもの**: Cloudflare アカウント（無料）+ Node.js 環境 + `wrangler` CLI
- **無料枠の範囲**: R2 ストレージ 10GB、月10万リクエスト、Egress 無料・無制限。
  個人写真家1人の利用なら十分余裕（[CLOUDFLARE.md](./gallery-worker/CLOUDFLARE.md)
  に詳細）
- **セットアップが難しいユーザー向け**: 現状 SETUP.md は CLI 知識前提。
  非エンジニア向けには動画ガイド or 対話スクリプト化が必要

### Cloudflare に依存しない選択肢（将来検討）

ギャラリーシェア機能だけが Cloudflare に依存しています。代替案として以下が
考えられますが、**現時点では未実装**:

- **ギャラリー機能を使わない**: 写真整理・投稿管理・現像連携は Cloudflare なしで
  動きます。設定でギャラリー欄を空のままにすればシェアボタンが無効化されるだけ。
- **セルフホスト Worker**: Worker のコードは標準的な TypeScript なので、
  Cloudflare の代わりに Deno Deploy / Bun + 任意のオブジェクトストレージ（MinIO 等）
  に移植可能。ただし Egress 無料という強みは失われる。
- **ローカル LAN 共有**: 撮影現場でその場でモデルに見せるだけなら、
  ローカルマシンで HTTP サーバー立ててLAN/Wi-Fi 経由でアクセスする版もあり得る。
  外出先でのレビューには使えない。

### 初回起動時の UX

現状、Cloudflare 設定がされていないとシェアボタンが disabled になるだけ。なぜ
使えないかが分かりにくいので、配布する際にはウェルカムダイアログや設定への
誘導を追加検討の余地あり。

---

## ドキュメント

| 文書 | 内容 |
|---|---|
| [REQUIREMENTS.md](./REQUIREMENTS.md) | 要件定義・設計書。機能仕様・データスキーマ・ワークフローの詳細。 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | コードベース構成。各モジュールの責務とデータフロー。 |
| [gallery-worker/SETUP.md](./gallery-worker/SETUP.md) | Cloudflare Worker のセットアップ手順。 |
| [gallery-worker/CLOUDFLARE.md](./gallery-worker/CLOUDFLARE.md) | Workers / R2 / KV をどう使っているかの解説。 |

---

## 技術スタック

| レイヤ | 採用技術 |
|---|---|
| アプリフレームワーク | Tauri 2.x |
| UI | React 19 + TypeScript |
| 仮想スクロール | `@tanstack/react-virtual` |
| バックエンド | Rust (`tauri`, `serde`, `image`, `webp`, `rayon`, `kamadak-exif`, `reqwest`) |
| ID 生成 | ULID |
| ギャラリーシェア | Cloudflare Workers + R2 + KV（無料枠運用） |

詳細は [REQUIREMENTS.md §2 技術スタック](./REQUIREMENTS.md)。

---

## ライセンス

個人プロジェクト。ライセンス未定。
