# Gallery Worker — Cloudflare setup

One-time setup before `wrangler deploy` works. All steps are free-tier.

## 1. Cloudflare account

- Sign up at https://dash.cloudflare.com/sign-up
- Email verification required.
- R2 bucket creation requires a payment method on file (no charge inside the free tier; this is the standard R2 onboarding).

## 2. Install wrangler & log in

```sh
cd gallery-worker
npm install
npx wrangler login    # opens a browser for OAuth
```

## 3. Create R2 bucket

```sh
npx wrangler r2 bucket create photo-gallery
```

If a different bucket name is preferred, update `bucket_name` in `wrangler.toml` to match.

## 4. Create KV namespace

```sh
npx wrangler kv namespace create GALLERY_KV
```

The command prints something like:
```
🌀 Creating namespace with title "photo-gallery-GALLERY_KV"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
{ binding = "GALLERY_KV", id = "abc123def456..." }
```

Copy the `id` and paste it into `wrangler.toml` (replace `REPLACE_WITH_KV_NAMESPACE_ID`).

## 5. Set the admin token (shared secret)

Generate any long random string — this is what the desktop app sends in
`Authorization: Bearer <token>` for upload/admin endpoints.

```sh
# On the worker side:
npx wrangler secret put ADMIN_TOKEN
# Paste the same token into the desktop app's Settings → Gallery.
```

## 6. Deploy

```sh
npx wrangler deploy
```

Worker is now live at `https://photo-gallery.<your-subdomain>.workers.dev`.

## 7. Local development (optional)

```sh
# Stub the secret for `wrangler dev`:
echo 'ADMIN_TOKEN=dev-token-12345' > .dev.vars

npx wrangler dev
```

`.dev.vars` is gitignored.

## Custom domain (later)

Once running on `*.workers.dev`, a custom hostname can be added without
breaking existing share links — the Worker serves both. In Cloudflare dash:
Workers & Pages → photo-gallery → Settings → Triggers → Add custom domain.
