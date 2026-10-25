# Cardsmith license server (itch.io rail only, not deployed)
Only needed if Cardsmith Pro is sold as an itch.io download key. Polar licenses never touch this; the plugin checks them directly with api.polar.sh.

`POST /v1/activate` and `POST /v1/validate` take `{key, product: "cardsmith"}`. The server calls `GET https://api.itch.io/games/$ITCH_GAME_ID/download_keys?download_key=KEY` with the secret itch API key, checks `game_id`, and returns `{ok:true, token}`, an ES256 JWT (7-day exp, `sub` = truncated SHA-256 of the key). Otherwise it returns `{ok:false, error}`. Rate limit: 10 requests/min per client (IP hashed, held in memory only). No storage bindings, no logging of keys or IPs.

Setup (needs Mira's OK + a Cloudflare account; not done):
1. `node scripts/keygen.mjs` → `.secrets/` (gitignored). A key pair was already generated on the box; its public x/y are in `../src/config.ts`.
2. `npx wrangler login`, then `wrangler secret put ITCH_API_KEY`, `ITCH_GAME_ID`, `SIGNING_JWK` (contents of `.secrets/signing.jwk.json`).
3. `npx wrangler deploy` → `https://cardsmith-license.<subdomain>.workers.dev`. Put that URL in `ITCH_LICENSE_SERVER_URL` and add it to the plugin README's network list.
Tests: `npx vitest run` (5 tests, fake itch API).
