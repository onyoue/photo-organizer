# Cullback gallery — self-hosted Bun server

Cloudflare Worker と互換のルーティングを持つ自前ホスト版。
[gallery-worker/](../gallery-worker/) と並列の選択肢で、デスクトップアプリの
API は同じなので**設定で URL を切り替えるだけ**で行き来できます。

R2 → ローカルファイル、KV → JSON ファイルに置き換わります。**Cloudflare
アカウント / 課金情報は一切不要**。HTTPS は Cloudflare Tunnel か任意の
リバースプロキシで提供します。

---

## 必要なもの

- **Bun** (https://bun.sh/) — もしくは Docker
- **Cloudflare アカウント（Tunnel 用、無料）** — もしくは Let's Encrypt 等で
  自前 HTTPS を立てる別経路
- **24時間動かせるマシン** — VPS / 自宅サーバー / NAS / 普段使いPC

「**自宅PC + Cloudflare Tunnel**」想定の手順は下にまとめてあります。
他環境でもポートを公開して HTTPS をかぶせるだけの話なので類推可能。

---

## 起動方法 1: Bun を直接（推奨・軽量）

```sh
cd gallery-server
cp .env.example .env
# .env を編集して ADMIN_TOKEN を入れる:
#   openssl rand -hex 32
# でランダム文字列を作って貼り付け

bun install      # 開発時のみ。型補完用
bun start        # 本番起動 — http://0.0.0.0:8787 でリッスン
```

systemd 化したいときの最小ユニット例:

```ini
# /etc/systemd/system/cullback-gallery.service
[Unit]
Description=Cullback gallery server
After=network.target

[Service]
WorkingDirectory=/srv/cullback
EnvironmentFile=/srv/cullback/.env
ExecStart=/usr/local/bin/bun run /srv/cullback/src/index.ts
Restart=on-failure
User=cullback

[Install]
WantedBy=multi-user.target
```

```sh
systemctl enable --now cullback-gallery
```

---

## 起動方法 2: Docker / Docker Compose

```sh
cd gallery-server
cp .env.example .env       # ADMIN_TOKEN を埋める
docker compose up -d
```

データは `./data/` にホスト側マウントされます。コンテナを作り直しても
データは失われません（消すときは明示的に `rm -rf data/`）。

---

## Cloudflare Tunnel での HTTPS 公開（自宅PC運用の典型ケース）

ルーターのポート開放 / 動的DNS / Let's Encrypt の自前管理が要らないので
楽です。

### A. cloudflared インストール

Windows: https://github.com/cloudflare/cloudflared/releases から `.msi`
macOS: `brew install cloudflared`
Linux: パッケージマネージャ or 公式 deb / rpm

### B. トンネルを作成

```sh
cloudflared tunnel login                       # ブラウザ認証
cloudflared tunnel create cullback             # 任意の名前
```

トンネル ID と `~/.cloudflared/<id>.json` 認証ファイルが作られます。

### C. 経路を設定

`~/.cloudflared/config.yml`:

```yaml
tunnel: <id>
credentials-file: /home/youruser/.cloudflared/<id>.json
ingress:
  - hostname: cullback.your-domain.com
    service: http://localhost:8787
  - service: http_status:404
```

DNS を貼り付け（Cloudflare 管理下のドメインが必要）:

```sh
cloudflared tunnel route dns cullback cullback.your-domain.com
```

### D. 起動

```sh
cloudflared tunnel run cullback
```

systemd 常駐:

```sh
sudo cloudflared service install
```

### E. Cloudflare-managed ドメインがない場合

`*.trycloudflare.com` の Quick Tunnel を使う:

```sh
cloudflared tunnel --url http://localhost:8787
```

その場で `https://random-words-xxx.trycloudflare.com` が発行されます。
**プロセスを再起動するたびに URL が変わる**ので、本番運用ではちゃんと
ドメインを当てたほうがいい。短時間の実験向け。

---

## デスクトップアプリ側の設定

設定 → Gallery セクション:

| 項目 | 入れる値 |
|---|---|
| Worker URL | Cloudflare Tunnel で公開した `https://cullback.your-domain.com`（末尾スラッシュなし） |
| Admin Token | `.env` に書いたのと同じランダム文字列 |
| Default Decision | OK or NG |

保存後、Share ボタンが有効になっていれば動いています。

---

## 同じ PC でデスクトップアプリと一緒に動かす場合

問題なく共存します。注意点:

- **ポート 8787** は他で使われていないか確認（`netstat -ano | findstr :8787`）。
  競合する場合は `.env` の `PORT` を変えて、 cloudflared 側の経路も合わせる
- アプリを開いていない時間帯にモデルがリンクを見に来ても OK にしたいなら、
  この PC は常時起動 or スリープ無効化 が前提。スリープすると Tunnel ごと落ちる
- 撮影会フォルダのバックアップ（写真データ）と、`gallery-server/data/`
  のバックアップは **別物**。後者にはアップロードされた共有用 JPG コピーと
  モデルからのフィードバックが入っているので、定期的に `tar` を取ること

---

## データの場所

`DATA_DIR` 配下（デフォルト `./data/`）:

| ディレクトリ | 内容 |
|---|---|
| `photos/<gid>/<pid>` | 写真本体（バイナリ） |
| `photos/<gid>/<pid>.meta.json` | 各写真の `{ contentType, size, crc32 }` |
| `galleries/<gid>.json` | ギャラリーのメタデータ（名前・期限・写真リスト・既定判定） |
| `feedback/<gid>/<pid>` | モデルが押した判定（`ok` / `ng` / `fav`、1ファイル1行） |
| `stats.json` | 集計値（バイト総量・写真枚数・ギャラリー数） |

形式はシンプルなので、`tar -czf cullback-backup.tar.gz data/` でまるっと
バックアップ可能。**SQLite すら使っていない** — 困ったときに `cat` で
中身が見られるという気軽さ重視。

---

## トラブルシュート

| 症状 | 原因 | 対処 |
|---|---|---|
| `ADMIN_TOKEN environment variable is required` で起動しない | `.env` 未読み込み or 未設定 | `bun --env-file=.env start` で起動するか、systemd の `EnvironmentFile=` を確認 |
| デスクトップから 401 Unauthorized | アプリ側 Token と `.env` の値が不一致 | 両方を同じ値に揃える |
| アプリから接続できない（タイムアウト） | Tunnel 起動忘れ or 経路設定ミス | `cloudflared tunnel info <name>` で稼働確認 |
| アップロード時に 413 | 1ファイル25MB超 | JPG の圧縮率を上げて再現像 |
| `permission denied` で起動しない | data ディレクトリの権限 | `chown -R youruser:youruser data` |
| Worker と並走させたい | できる | デスクトップアプリのプロファイルを切り替えるか、Worker 側はそのまま放置（Bearer 違うので干渉しない） |

---

## ライセンスと外向け公開について

- このサーバは認証が **Bearer（管理API）+ ULID-only（公開URL）**。Worker と同じ
  モデル
- **モデルへの URL は推測不能** だが、URL が漏れると見られる前提なので、
  本当に機密性が要る写真には別途パスワード付与等の追加対策を検討
- ログは `console.log` レベル — 本番では reverse proxy 側でアクセスログを
  取るのが一般的
