# Cloudflare 構成ガイド

このアプリの「ギャラリー共有」機能は、Cloudflare の3つのサービスを
組み合わせて動いています。Cloudflare を初めて使う前提で、何を・どう
使っているかをまとめます。

セットアップ手順そのものは [SETUP.md](./SETUP.md) を参照してください。
こちらは「動いている裏側で何が起きているか」の説明です。

---

## なぜ Cloudflare?

写真共有サービス（Pixieset 等）を使わず自作している都合上、
**ホスティング費用をほぼゼロに保つ** のが要件でした。

Cloudflare を選んだ決め手:

- **R2 の Egress（ダウンロード転送量）が無料・無制限**
  AWS S3 等は転送量1GBあたり $0.09 程度かかる。モデルが何度も写真を
  見返したり ZIP で一括DLしたりする使い方では、ここの差が大きい。
- 個人写真家1人の利用規模なら **3サービスとも無料枠に収まる**
- セットアップも `wrangler deploy` 一発で済む

---

## 使っている3つのサービス

```
                 ┌────────────────────────────────────┐
                 │  Cloudflare Worker (cullback)      │
                 │   ─ ルーティング・認証・ZIP生成等  │
                 └────────────┬───────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                                   ▼
   ┌─────────────────┐               ┌─────────────────┐
   │       R2        │               │       KV        │
   │  写真の本体     │               │  メタデータ・   │
   │ (JPG/PNG ファ   │               │  フィードバック │
   │  イル)          │               │                 │
   └─────────────────┘               └─────────────────┘
```

### 1. Workers — サーバーレスのエッジ実行環境

**役割:** HTTPリクエストを受けて、ルーティング・認証・HTML生成・
ZIPストリーミングを行う「アプリ本体」。

- ソースは [src/](./src/) 以下の TypeScript
- デプロイ後は `https://cullback.<your-subdomain>.workers.dev` で公開
  （このプロジェクトの場合は `https://cullback.qohchan.workers.dev`）
- 全リクエストが Cloudflare のエッジ（世界各地のサーバー）で実行されるので
  自前でサーバーを立てる必要がない
- 設定ファイルは [wrangler.toml](./wrangler.toml)

**このアプリが Workers でやっていること:**
- `PUT /admin/<gid>` : 新規ギャラリー作成（メタを KV に保存）
- `PUT /admin/<gid>/photos/<pid>` : 写真を R2 にアップロード
- `GET /<gid>` : モデル向けのギャラリーHTMLを動的に生成して返す
- `GET /<gid>/p/<pid>` : R2 から写真バイトを取り出して中継
- `GET /<gid>/zip` : 選択写真の ZIP をストリーミング
- `POST /<gid>/feedback` : OK/NG/FAV を KV に書き込む
- `GET /admin/<gid>/feedback` : フィードバックをまとめてアプリに返す
- `GET /admin/stats` : 無料枠の使用状況（後述）

### 2. R2 — オブジェクトストレージ

**役割:** 写真ファイル（JPG/PNG のバイナリ）の保存場所。
S3 互換のオブジェクトストレージ。

- バケット名: `photo-gallery`（[wrangler.toml](./wrangler.toml) の
  `bucket_name`）— Cullbackリブランド前の旧名のまま。バケット名は
  公開URLには現れず、改名にはR2オブジェクト全コピーが必要なので保留
- Worker 内では `env.GALLERY_BUCKET` という名前でアクセス
- **キーの命名規則:** `<gid>/p/<pid>`
  例: `01HVZ.../p/p001`

**保存しているもの:**
- 写真本体（バイナリ）
- カスタムメタデータとして `crc32` と `size` も R2 オブジェクトに記録
  （ZIP を Worker の CPU 制限内で組み立てるためのチート。CRC を
  事前計算して保存しておけば、配信時は中身を読まずにそのまま流せる）

### 3. KV — キーバリューストア

**役割:** メタデータと設定値の保存場所。値は文字列（実際は JSON 文字列）。

- ネームスペース binding: `GALLERY_KV`（[wrangler.toml](./wrangler.toml)）
- 全エッジで結果整合な分散KV。ライトはやや遅いが、リードはミリ秒単位で
  返ってくる

**キー設計:**

| キー形式 | 値 | 何のため |
|---|---|---|
| `gallery:<gid>` | JSON: `{name, expires_at, default_decision, photos[], finalized}` | ギャラリー単位のメタデータ |
| `feedback:<gid>:<pid>` | `"ok"` / `"ng"` / `"fav"` | モデルが押した判定（写真ごと） |
| `stats:totals` | JSON: `{r2_bytes, photo_count, gallery_count, updated_at}` | 無料枠の使用状況集計 |

**`stats:totals` は最近追加した集計キャッシュ:**
作成・アップロード・削除のたびに increment/decrement するのでKVのwriteを
1日1000回まで使い切らないよう注意して設計しています。
ずれた場合は `POST /admin/stats/recompute` で再集計できます
（シェア画面の「再計算」ボタン）。

---

## データの流れ

### A. 写真をシェアする（デスクトップアプリから）

```
[アプリ] ──PUT /admin/<gid>──────────────► [Worker]
   │       (gallery meta JSON)                │
   │                                          ├──► [KV] gallery:<gid> 書き込み
   │                                          └──► [KV] stats:totals +1ギャラリー
   │
   ├──PUT /admin/<gid>/photos/p001──────► [Worker]
   │   (JPGバイト)                            ├──► CRC32計算
   │                                          ├──► [R2] <gid>/p/p001 書き込み
   │                                          └──► [KV] stats:totals +bytes,+photo
   │
   ├──(バリエーションぶん繰り返し)
   │
   └──POST /admin/<gid>/finalize ──────► [Worker]
                                              └──► [KV] gallery:<gid> finalized=true
```

### B. モデルがスマホで見る

```
[スマホブラウザ] ──GET /<gid>──────► [Worker]
                                        ├──► [KV] gallery:<gid> 読み込み
                                        ├──► [KV] feedback:<gid>:* 一覧取得
                                        └──► HTML を生成して返却

[スマホブラウザ] ──GET /<gid>/p/p001──► [Worker]
                                        └──► [R2] <gid>/p/p001 をストリーム

[スマホブラウザ] ──POST /<gid>/feedback ► [Worker]
                  {pid, decision: "fav"}    └──► [KV] feedback:<gid>:p001 = "fav"
```

### C. フィードバックをアプリで取り込む

```
[アプリ] ──GET /admin/<gid>/feedback ► [Worker]
                                          ├──► [KV] feedback:<gid>:* 全件取得
                                          └──► {default_decision, decisions{}}を返却

  ↓
  アプリ側で各バンドルの flag を更新（FAV → pick / NG → reject /
  OK → ok）してサイドカーJSON+キャッシュに書き戻し。
```

---

## 無料枠と監視

| サービス | 主な制限 | このアプリでの感触 |
|---|---|---|
| Workers | 100,000 リクエスト / 日 | まず到達しない |
| R2 | **ストレージ 10 GB** | 一番先に来る。1000バンドルくらいで満杯 |
| R2 | Egress **無料・無制限** | DLし放題 |
| R2 | Class A 1M / 月、Class B 10M / 月 | 個人利用ではまず到達しない |
| KV | 読み取り 100,000 / 日 | 普通の閲覧では問題なし |
| KV | **書き込み 1,000 / 日** | フィードバックタップ数 + アップロード数。意識する価値あり |
| KV | 削除 1,000 / 日 | ギャラリー1件削除 = 写真ぶん + メタ |

**現状の使用量はシェア画面の上部バナーで確認できます:**
- R2 ストレージのバー（80%で黄色、100%超で赤＋警告）
- 写真枚数 / ギャラリー件数
- 「再計算」ボタンで Worker 側全件スキャンで集計しなおし

---

## 設定とシークレット

### [wrangler.toml](./wrangler.toml) に書くもの（公開してOK）

- Worker 名 (`name`)
- compatibility_date
- R2 バケット名 と binding 名
- KV ネームスペース ID と binding 名

これらは識別子なので、GitHub に push しても問題ありません。
**実際のアクセスには Cloudflare アカウント認証が別途必要** だからです。

### `wrangler secret put` で設定するもの（絶対に公開しない）

- **`ADMIN_TOKEN`** : デスクトップアプリが `Authorization: Bearer <token>`
  で送る共有秘密。これを知っている人だけがギャラリー作成・削除できる。

```sh
npx wrangler secret put ADMIN_TOKEN
# プロンプトで値を貼り付ける
```

ローカル `wrangler dev` 用には `.dev.vars` ファイル（gitignore済み）に
`ADMIN_TOKEN=...` を書いておく。

### デスクトップアプリ側の設定

設定 → Gallery で:
- **Worker URL**: `https://cullback.<your-subdomain>.workers.dev`
- **Admin Token**: `wrangler secret put` で設定したのと同じ値
- **Default Decision**: OK / NG（モデルがタップしなかった写真の扱い）

これらは `app_data_dir/settings.json` に保存されます。

---

## 日常メンテ

### Worker をデプロイし直す（コード変更後）

```sh
cd gallery-worker
npx wrangler deploy
```

### ログを見る（リアルタイム）

```sh
npx wrangler tail
```

エラー時の Worker 側スタックトレースが見られる。

### KV を手動でいじる（緊急時）

```sh
# 全キー一覧
npx wrangler kv key list --binding GALLERY_KV

# 値を取得
npx wrangler kv key get --binding GALLERY_KV "gallery:01HVZ..."

# 削除
npx wrangler kv key delete --binding GALLERY_KV "gallery:01HVZ..."
```

通常はアプリ側のギャラリー一覧 → 削除で十分なので、ここを使うのは
ギャラリーが finalize できずに孤児R2オブジェクトが残ったとき等の
事故対応用。

### R2 を手動でいじる

```sh
# バケット内オブジェクト一覧
npx wrangler r2 object list photo-gallery

# 削除
npx wrangler r2 object delete photo-gallery <gid>/p/<pid>
```

### 無料枠の消費を Cloudflare 側で確認する

ダッシュボード（https://dash.cloudflare.com/）で:
- **Workers & Pages → cullback → Metrics**: リクエスト数・CPU時間
- **R2 → photo-gallery → Metrics**: ストレージ・Class A/B操作数
  （バケットは旧名のまま）
- **Workers & Pages → KV → photo-gallery-GALLERY_KV → Metrics**: 読み書き数
  （ネームスペース名も旧名のまま）

アプリ内のバナーが「Worker が記録した値」なのに対し、こちらは
「Cloudflare が計上した実値」。乖離していたらアプリの集計バグの可能性。

---

## カスタムドメイン化（任意）

`*.workers.dev` のままでも問題ありませんが、後から独自ドメインに
切り替えたい場合:

1. Cloudflare ダッシュボード → Workers & Pages → cullback
2. Settings → Triggers → Add Custom Domain
3. ドメインを入れて保存

**既存の共有リンクは壊れません** — Worker は両方のホスト名で動き続けます。

---

## トラブルシュート

| 症状 | 原因 | 対処 |
|---|---|---|
| アップロードで 401 Unauthorized | ADMIN_TOKEN が一致していない | デスクトップ側設定 と `wrangler secret put` の値を揃える |
| アップロードで 413 Payload Too Large | 1ファイル25MB超過 | JPGの圧縮率を上げる |
| ZIP取得で500 | R2にCRCメタなし（古いアップロード） | 該当ギャラリーを削除して再共有 |
| シェア画面のバナーが0のまま | stats:totals が古いまま | 「再計算」ボタンを1回押す |
| `wrangler deploy` で R2 not found | バケット未作成 | `wrangler r2 bucket create photo-gallery` |
