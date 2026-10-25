import { describe, expect, it } from "vitest";
import { normalizeItchKey, ServerLicenseProvider } from "../src/license/server-provider";
import { PolarLicenseProvider } from "../src/license/polar-provider";
import { LicenseManager } from "../src/license/manager";
import { verifyToken, importPublicKey } from "../src/license/token";
import type { HttpRequest, HttpResponse } from "../src/ai/providers";
import type { StoredLicense } from "../src/license/types";

const enc = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
async function keys() {
	const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
	const sign = async (claims: Record<string, unknown>, alg = "ES256") => {
		const h = enc({ alg, typ: "JWT" });
		const p = enc(claims);
		const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, new TextEncoder().encode(`${h}.${p}`));
		return `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
	};
	return { pub: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y } as JsonWebKey, sign };
}
const now = () => Math.floor(Date.now() / 1000);
const claims = { v: 1, aud: "cardsmith", plan: "pro", prv: "itch", sub: "abc", iat: now(), exp: now() + 7 * 86400 };
const ITCH_KEY = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6abcd";

describe("token", () => {
	it("verifies ES256 signature, audience and plan", async () => {
		const k = await keys();
		const pk = await importPublicKey(k.pub);
		expect(await verifyToken(await k.sign(claims), pk, "cardsmith")).toMatchObject({ plan: "pro" });
		expect(await verifyToken(await k.sign({ ...claims, aud: "other" }), pk, "cardsmith")).toBeNull();
		expect(await verifyToken(await k.sign(claims, "none"), pk, "cardsmith")).toBeNull();
		const t = await k.sign(claims);
		const forged = t.split(".").map((x, i) => (i === 1 ? enc({ ...claims, sub: "me" }) : x)).join(".");
		expect(await verifyToken(forged, pk, "cardsmith")).toBeNull();
		const other = await keys();
		expect(await verifyToken(await other.sign(claims), pk, "cardsmith")).toBeNull();
	});
});

describe("ServerLicenseProvider (itch, secondary)", () => {
	it("pulls the key out of a pasted itch download URL", () => {
		expect(normalizeItchKey(`https://miraforge.itch.io/cardsmith-pro/download/${ITCH_KEY}`)).toBe(ITCH_KEY);
		expect(normalizeItchKey(`  ${ITCH_KEY} `)).toBe(ITCH_KEY);
	});
	it("is disabled with no server URL or public key (default build)", async () => {
		const k = await keys();
		expect(new ServerLicenseProvider(async () => ({ status: 200, json: {}, text: "" }), "", k.pub).isConfigured()).toBe(false);
		expect(new ServerLicenseProvider(async () => ({ status: 200, json: {}, text: "" }), "https://x.workers.dev", { kty: "EC", x: "__REPLACE_X__" }).isConfigured()).toBe(false);
	});
	it("activates through the server, verifies the token offline, and maps errors", async () => {
		const k = await keys();
		const calls: HttpRequest[] = [];
		let reply: HttpResponse = { status: 200, json: { ok: true, token: await k.sign(claims) }, text: "" };
		const http = async (r: HttpRequest) => (calls.push(r), reply);
		const p = new ServerLicenseProvider(http, "https://license.example.dev", k.pub);
		const g = await p.activate(`https://miraforge.itch.io/cardsmith-pro/download/${ITCH_KEY}`);
		expect(g.source).toBe("itch");
		expect(JSON.parse(calls[0]!.body!)).toEqual({ key: ITCH_KEY, product: "cardsmith" });
		const stored: StoredLicense = { key: ITCH_KEY, providerId: "itch", source: "itch", token: g.token, expiresAt: null, lastValidatedAt: Date.now() };
		expect(await p.verifyOffline(stored)).toBe(true);
		expect(await p.verifyOffline({ ...stored, token: "x.y.z" })).toBe(false);
		reply = { status: 200, json: { ok: true, token: await (await keys()).sign(claims) }, text: "" };
		await expect(p.activate(ITCH_KEY)).rejects.toMatchObject({ kind: "server" });
		reply = { status: 200, json: { ok: false, error: "invalid download key" }, text: "" };
		await expect(p.activate(ITCH_KEY)).rejects.toMatchObject({ kind: "invalid" });
		reply = { status: 429, json: {}, text: "" };
		await expect(p.activate(ITCH_KEY)).rejects.toMatchObject({ kind: "rate_limited" });
	});
	it("Polar is tried first; itch-shaped keys go to itch", async () => {
		const k = await keys();
		const hosts: string[] = [];
		const token = await k.sign(claims);
		const http = async (r: HttpRequest): Promise<HttpResponse> => {
			hosts.push(new URL(r.url).host);
			return r.url.includes("polar") ? { status: 404, json: { detail: "not found" }, text: "" } : { status: 200, json: { ok: true, token }, text: "" };
		};
		let stored: StoredLicense | null = null;
		const mgr = new LicenseManager(
			[
				new PolarLicenseProvider(http, { apiBase: "https://api.polar.sh", organizationId: "1dbfc517-0bbf-4301-9ba8-555ca42b9737", benefitIds: [], keyPrefix: "CARDSMITH", deviceLabel: "x" }),
				new ServerLicenseProvider(http, "https://license.example.dev", k.pub),
			],
			() => stored,
			async (l) => void (stored = l),
		);
		expect((await mgr.activate(ITCH_KEY)).state).toBe("pro");
		expect(hosts).toEqual(["license.example.dev"]);
		expect(stored!.providerId).toBe("itch");
		expect((await mgr.restore()).state).toBe("pro");
		stored = { ...stored!, token: "tampered.token.here" };
		expect((await mgr.restore()).state).toBe("free");
	});
});
