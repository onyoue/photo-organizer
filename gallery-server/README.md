# Cullback gallery — self-hosted Bun server

[gallery-worker/](../gallery-worker/) の Cloudflare Worker と機能互換の自前
ホスト版。デスクトップアプリの API は同じ。

## いつ使うか

- **Cloudflare R2 / KV のオンボーディング（クレカ登録等）を避けたい**
- **写真データを自分の管理下に置きたい**
- **既に自宅サーバーや VPS を持っていて、もう1個動かす程度は問題ない**

そうでなければ Cloudflare Worker 版（[gallery-worker/](../gallery-worker/)）
の方が「動かしっぱなしの心配が要らない」ぶん楽です。

## 互換性

| 項目 | Worker | この自前ホスト版 |
|---|---|---|
| デスクトップ API | 同じ | 同じ |
| モバイルレビュー UI | 同じ | 同じ |
| ストレージ | R2 + KV | ローカルファイル |
| HTTPS | 自動 | リバプロ / Tunnel で自前 |
| 起動 | `wrangler deploy` | `bun start` or `docker compose up` |
| データバックアップ | Cloudflare 任せ | `tar` で `data/` ディレクトリを |

## セットアップ

[SETUP.md](./SETUP.md) を参照（Cloudflare Tunnel 経由の HTTPS 公開手順込み）。

```sh
cd gallery-server
cp .env.example .env       # ADMIN_TOKEN を埋める
bun install
bun start                  # http://0.0.0.0:8787
```

詳細・systemd 化・Docker 化・トラブルシュート: [SETUP.md](./SETUP.md)。

## アーキテクチャ

| ファイル | 役割 |
|---|---|
| `src/index.ts` | Bun.serve エントリ + ルーティング + Bearer 認証 |
| `src/admin.ts` | 写真家用エンドポイント（PUT/POST/DELETE /admin/*） |
| `src/public.ts` | 公開エンドポイント（GET /\<gid\>, /zip, POST /feedback 等） |
| `src/storage.ts` | ファイルシステム上の R2 / KV 相当ヘルパー（atomic write、JSON sidecar） |
| `src/html.ts` | モバイルレビュー HTML（Worker からそのままコピー） |
| `src/zip.ts` | STORE-method ZIP ストリーム生成（Worker からそのままコピー） |
| `src/types.ts` | 共通型 |
| `src/util.ts` | レスポンスヘルパー |

`html.ts` `zip.ts` `types.ts` は Worker 版と同一コードです（コピー）。
将来的に共通モジュール化したくなったら `shared/` を作って両方が参照する
形に整理可能。
