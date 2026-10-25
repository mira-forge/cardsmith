/**
 * Cardsmith license server (itch.io rail only). Cloudflare Worker, no storage.
 *
 * Why it exists: itch.io's API key grants full account access, so it can't ship in the
 * plugin. This Worker checks an itch download key server-side and returns a short-lived
 * ES256-signed token the plugin can verify offline. Polar keys never come here; the
 * plugin checks those directly with api.polar.sh.
 *
 * Personal data: none stored. No logs of keys or IPs are written by this code; the
 * token's `sub` is a truncated SHA-256 of the key. Rate limiting is an in-memory,
 * per-isolate counter keyed by a hash of the client IP that lives only in RAM.
 *
 * Secrets (set with `wrangler secret put`, never committed):
 *   ITCH_API_KEY   itch.io API key (ideally from a dedicated OAuth app; see README)
 *   ITCH_GAME_ID   numeric id of the "Cardsmith Pro" itch page
 *   SIGNING_JWK    private ES256 JWK (JSON string) from scripts/keygen.mjs
 */

export interface Env {
	ITCH_API_KEY: string;
	ITCH_GAME_ID: string;
	SIGNING_JWK: string;
}

export const TOKEN_TTL_S = 7 * 24 * 60 * 60;
const PRODUCT = "cardsmith";
const RATE_LIMIT = 10; // requests
const RATE_WINDOW_MS = 60_000; // per minute per client

const buckets = new Map<string, { n: number; reset: number }>();
export function rateLimited(id: string, now = Date.now()): boolean {
	const b = buckets.get(id);
	if (!b || now > b.reset) {
		buckets.set(id, { n: 1, reset: now + RATE_WINDOW_MS });
		if (buckets.size > 10_000) for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
		return false;
	}
	b.n++;
	return b.n > RATE_LIMIT;
}
export function resetRateLimits(): void {
	buckets.clear();
}

const b64url = (buf: ArrayBuffer | Uint8Array) => {
	const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	let s = "";
	for (const x of bytes) s += String.fromCharCode(x);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function sha256hex(s: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let signingKey: CryptoKey | null = null;
let signingKeySrc = "";
async function getSigningKey(env: Env): Promise<CryptoKey> {
	if (!signingKey || signingKeySrc !== env.SIGNING_JWK) {
		signingKey = await crypto.subtle.importKey("jwk", JSON.parse(env.SIGNING_JWK) as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
		signingKeySrc = env.SIGNING_JWK;
	}
	return signingKey;
}

export async function signToken(env: Env, sub: string, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
	const h = b64urlJson({ alg: "ES256", typ: "JWT" });
	const p = b64urlJson({ v: 1, aud: PRODUCT, plan: "pro", prv: "itch", sub, iat: nowS, exp: nowS + TOKEN_TTL_S });
	const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await getSigningKey(env), new TextEncoder().encode(`${h}.${p}`));
	return `${h}.${p}.${b64url(sig)}`;
}

/** Ask itch.io whether this download key belongs to our game. */
export async function checkItchKey(env: Env, key: string, fetcher: typeof fetch = fetch): Promise<"valid" | "invalid" | "error"> {
	const url = `https://api.itch.io/games/${encodeURIComponent(env.ITCH_GAME_ID)}/download_keys?download_key=${encodeURIComponent(key)}`;
	let res: Response;
	try {
		res = await fetcher(url, { headers: { Authorization: `Bearer ${env.ITCH_API_KEY}` } });
	} catch {
		return "error";
	}
	if (res.status >= 500) return "error";
	const j = (await res.json().catch(() => null)) as { download_key?: { game_id?: number | string }; errors?: string[] } | null;
	if (j?.download_key && String(j.download_key.game_id) === String(env.ITCH_GAME_ID)) return "valid";
	if (j?.errors || j?.download_key) return "invalid";
	return "error";
}

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" },
	});

export async function handle(req: Request, env: Env, fetcher: typeof fetch = fetch): Promise<Response> {
	const url = new URL(req.url);
	if (req.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" } });
	}
	if (req.method === "GET" && url.pathname === "/") return json(200, { ok: true, service: "cardsmith-license", rails: ["itch"] });
	if (req.method !== "POST" || !["/v1/activate", "/v1/validate"].includes(url.pathname)) return json(404, { ok: false, error: "not found" });

	const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
	if (rateLimited((await sha256hex(ip)).slice(0, 16))) return json(429, { ok: false, error: "Too many attempts. Wait a minute and try again." });

	const body = (await req.json().catch(() => null)) as { key?: unknown; product?: unknown } | null;
	const key = typeof body?.key === "string" ? body.key.trim() : "";
	if (body?.product !== PRODUCT || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) return json(400, { ok: false, error: "That license key was not recognised." });

	const verdict = await checkItchKey(env, key, fetcher);
	if (verdict === "error") return json(502, { ok: false, error: "Could not reach itch.io. Try again later." });
	if (verdict === "invalid") return json(200, { ok: false, error: "That itch.io download key is not valid for Cardsmith Pro (or the purchase was refunded)." });
	const sub = (await sha256hex(key)).slice(0, 24);
	return json(200, { ok: true, token: await signToken(env, sub) });
}

export default {
	fetch(req: Request, env: Env): Promise<Response> {
		return handle(req, env);
	},
};
