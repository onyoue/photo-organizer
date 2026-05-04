# Cullback gallery Worker — Cloudflare setup

ギャラリーシェア機能を有効化するための一回きりの初期セットアップ手順。
全部 Cloudflare 無料枠の範囲内で完結します。

> 旧バージョンのリポジトリは `photo-gallery` という名前で Worker / R2 バケットを
> 作っていました。新規セットアップなら下記の通り `cullback` 名で進めてください。
> 既存セットアップがあって名前を引き継ぎたい場合は `wrangler.toml` の
> `name` と `bucket_name` を実際の名前に書き換えてください。

---

## 必要なもの

| ツール | 用途 | インストール |
|---|---|---|
| **Node.js 20+** | wrangler CLI を動かす | https://nodejs.org/ |
| **Cloudflare アカウント** | Workers / R2 / KV を使う | https://dash.cloudflare.com/sign-up（無料） |
| **クレジットカード** | R2 の onboarding で payment method 登録を求められる（無料枠内なら課金なし） | — |

セットアップは慣れていれば 10 分、初めてなら 30 分くらい見ておくと余裕です。

---

## 1. Cloudflare アカウントを作る

1. https://dash.cloudflare.com/sign-up でメール登録
2. メール認証
3. 初回ログイン時に R2 を有効化するためクレジットカード登録を求められる場合あり。
   無料枠（10GB ストレージ / Egress 無制限）の範囲内なら課金されない

---

## 2. wrangler CLI のインストール + ログイン

```sh
cd gallery-worker
npm install            # wrangler がここに入る
npx wrangler login     # ブラウザが開いて OAuth → 「Allow」
```

ログイン状態は `npx wrangler whoami` で確認できます。

---

## 3. R2 バケットを作る

```sh
npx wrangler r2 bucket create cullback
```

成功すると次のような出力:

```
Creating bucket 'cullback'...
✓ Created bucket 'cullback'
```

> 名前を変えたい場合は `wrangler.toml` の `bucket_name` も対応する名前に
> 書き換えてください。

---

## 4. KV ネームスペースを作る

```sh
npx wrangler kv namespace create GALLERY_KV
```

出力例:

```
🌀 Creating namespace with title "cullback-GALLERY_KV"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
{ binding = "GALLERY_KV", id = "abc123def456..." }
```

**`id = "..."` の部分をコピー** して `wrangler.toml` の
`REPLACE_WITH_KV_NAMESPACE_ID` を置き換える:

```toml
[[kv_namespaces]]
binding = "GALLERY_KV"
id = "abc123def456..."   # ← ここに貼り付け
```

---

## 5. ADMIN_TOKEN（共有秘密）を設定

デスクトップアプリと Worker を繋ぐ認証用の長いランダム文字列です。
PowerShell で:

```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Min 0 -Max 256) })
```

bash/zsh で:

```sh
openssl rand -hex 32
```

出てきた文字列を **メモ** してください（後でアプリ側設定にも貼り付けます）。

Worker 側に登録:

```sh
npx wrangler secret put ADMIN_TOKEN
```

プロンプトで上記の文字列を貼り付けて Enter。

---

## 6. デプロイ

```sh
npx wrangler deploy
```

成功すると次のような出力（`<account-subdomain>` はアカウントごとに異なる）:

```
Total Upload: 23.45 KiB / gzip: 8.23 KiB
Worker Startup Time: 12 ms
Uploaded cullback (5.20 sec)
Deployed cullback triggers (1.03 sec)
  https://cullback.<account-subdomain>.workers.dev
```

最後の URL がギャラリー Worker のエンドポイントです。**メモしてください**。

---

## 7. デスクトップアプリ側の設定

アプリを起動 → 設定 (⚙) → Gallery セクション:

| 項目 | 入れる値 |
|---|---|
| Worker URL | `https://cullback.<account-subdomain>.workers.dev` （Step 6 で出てきたもの） |
| Admin Token | Step 5 でメモしたランダム文字列 |
| Default Decision | OK or NG（モデルがタップしなかった写真の扱い） |

保存後、Share ボタンが有効になっていればセットアップ成功です。

---

## ローカル開発（任意）

Worker のコードを改修したいときの開発ループ:

```sh
# Stub the secret for `wrangler dev`:
echo 'ADMIN_TOKEN=dev-token-12345' > .dev.vars
npx wrangler dev   # http://localhost:8787 で動く
```

`.dev.vars` は gitignored。

---

## カスタムドメイン化（将来）

`*.workers.dev` のままでも問題ないですが、独自ドメインを当てたい場合:

1. Cloudflare ダッシュボード → Workers & Pages → cullback
2. Settings → Triggers → Add Custom Domain
3. ドメインを入れて保存

**既存の共有リンクは壊れません** — Worker は両方のホスト名で動き続けます。

---

## トラブルシュート

| 症状 | 原因 | 対処 |
|---|---|---|
| `wrangler login` でブラウザが開かない | ブラウザのデフォルト設定 | URL を手動でブラウザに貼り付ける |
| `r2 bucket create` で `payment method required` | R2 の初回 onboarding | Cloudflare ダッシュボードで決済情報登録（無料枠内なら課金なし） |
| `kv namespace create` で permission denied | account_id が wrangler.toml にない | `npx wrangler whoami` で確認、必要なら `wrangler.toml` に `account_id = "..."` を追加 |
| デプロイは成功するが URL にアクセスできない | DNS 反映待ち | 1-2 分待って再アクセス |
| アプリから 401 Unauthorized | ADMIN_TOKEN がアプリ側と Worker 側で不一致 | アプリの設定と `wrangler secret put ADMIN_TOKEN` の値を揃える |
| アップロード時に 413 Payload Too Large | 1 ファイル 25MB 超過 | JPG の圧縮率を上げる |
| アプリで「無料枠の取得に失敗」 | 旧 Worker 名で `wrangler secret put` していない | 新しい Worker 名で `npx wrangler secret put ADMIN_TOKEN` を再実行 |

それ以外で詰まったら [CLOUDFLARE.md](./CLOUDFLARE.md) の解説や
`npx wrangler tail` でリアルタイムログを見ると原因が掴めます。
