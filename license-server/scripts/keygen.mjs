// Generates the ES256 signing key pair. Private JWK -> .secrets/signing.jwk.json (gitignored,
// upload with `wrangler secret put SIGNING_JWK < .secrets/signing.jwk.json`).
// Public x/y -> paste into the plugin's src/config.ts LICENSE_PUBLIC_JWK.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
const out = new URL("../.secrets/", import.meta.url);
if (existsSync(new URL("signing.jwk.json", out)) && !process.argv.includes("--force")) {
	console.error("A key already exists in .secrets/. Use --force to replace it (this invalidates issued tokens).");
	process.exit(1);
}
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("signing.jwk.json", out), JSON.stringify(priv), { mode: 0o600 });
writeFileSync(new URL("public.jwk.json", out), JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }, null, 2));
console.log("Public key for src/config.ts:", JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }));
