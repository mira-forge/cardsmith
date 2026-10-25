import { beforeEach, describe, expect, it } from "vitest";
import { handle, resetRateLimits, TOKEN_TTL_S, type Env } from "../src/index";

const GAME = "3141592";
const GOOD = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6abcd";
const OTHER_GAME = "ffffffffffffffffffffffffffffffffffffffff";

async function env(): Promise<{ env: Env; pub: CryptoKey }> {
	const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	return { env: { ITCH_API_KEY: "itch-secret", ITCH_GAME_ID: GAME, SIGNING_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", kp.privateKey)) }, pub: kp.publicKey };
}

const seen: { url: string; auth: string | null }[] = [];
const fakeItch: typeof fetch = async (input, init) => {
	const url = String(input);
	seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
	const k = new URL(url).searchParams.get("download_key");
	if (k === GOOD) return new Response(JSON.stringify({ download_key: { id: 1, game_id: Number(GAME), owner: { username: "buyer" } } }));
	if (k === OTHER_GAME) return new Response(JSON.stringify({ download_key: { id: 2, game_id: 999 } }));
	return new Response(JSON.stringify({ errors: ["invalid download key"] }));
};
const post = (path: string, body: unknown, ip = "203.0.113.7") =>
	new Request(`https://license.example.dev${path}`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify(body) });

beforeEach(() => { resetRateLimits(); seen.length = 0; });

describe("license server", () => {
	it("issues a verifiable 7-day ES256 token for a valid key, with no personal data", async () => {
		const { env: e, pub } = await env();
		const res = await handle(post("/v1/activate", { key: GOOD, product: "cardsmith" }), e, fakeItch);
		const j = (await res.json()) as { ok: boolean; token: string };
		expect(j.ok).toBe(true);
		expect(seen[0]!.url).toBe(`https://api.itch.io/games/${GAME}/download_keys?download_key=${GOOD}`);
		expect(seen[0]!.auth).toBe("Bearer itch-secret");
		const [h, p, s] = j.token.split(".") as [string, string, string];
		const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, Buffer.from(s, "base64url"), new TextEncoder().encode(`${h}.${p}`));
		expect(ok).toBe(true);
		const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, number | string>;
		expect(claims).toMatchObject({ aud: "cardsmith", plan: "pro", prv: "itch" });
		expect(Number(claims.exp) - Number(claims.iat)).toBe(TOKEN_TTL_S);
		expect(j.token).not.toContain(GOOD);
		expect(JSON.stringify(claims)).not.toMatch(/buyer/);
	});
	it("rejects invalid, refunded and other-game keys", async () => {
		const { env: e } = await env();
		for (const key of ["b".repeat(40), OTHER_GAME]) {
			const j = (await (await handle(post("/v1/validate", { key, product: "cardsmith" }), e, fakeItch)).json()) as { ok: boolean };
			expect(j.ok).toBe(false);
		}
		expect((await handle(post("/v1/activate", { key: "short", product: "cardsmith" }), e, fakeItch)).status).toBe(400);
		expect((await handle(post("/v1/activate", { key: GOOD, product: "other" }), e, fakeItch)).status).toBe(400);
	});
	it("returns 502 when itch is down, so the plugin keeps its offline grace", async () => {
		const { env: e } = await env();
		const down: typeof fetch = async () => { throw new Error("down"); };
		expect((await handle(post("/v1/validate", { key: GOOD, product: "cardsmith" }), e, down)).status).toBe(502);
	});
	it("rate limits per client", async () => {
		const { env: e } = await env();
		const codes: number[] = [];
		for (let i = 0; i < 12; i++) codes.push((await handle(post("/v1/validate", { key: GOOD, product: "cardsmith" }), e, fakeItch)).status);
		expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
		expect(codes.slice(10)).toEqual([429, 429]);
		expect((await handle(post("/v1/validate", { key: GOOD, product: "cardsmith" }, "198.51.100.1"), e, fakeItch)).status).toBe(200);
	});
	it("404s other routes", async () => {
		const { env: e } = await env();
		expect((await handle(new Request("https://x/v1/nope", { method: "POST" }), e, fakeItch)).status).toBe(404);
		expect((await handle(new Request("https://x/"), e, fakeItch)).status).toBe(200);
	});
});
