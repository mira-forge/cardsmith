import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { normalizeStripeKey, newDeviceId, StripeLicenseProvider } from "../src/license/stripe-provider";
import { LicenseManager } from "../src/license/manager";
import { LicenseError, type StoredLicense } from "../src/license/types";
import { LICENSE_RAIL, PRO_PAGE_URL, POLAR_PRO_PAGE_URL } from "../src/config";
import type { HttpRequest, HttpResponse } from "../src/ai/providers";

const KEY = "CARDSMITH-DJ5JJ-MP6CX-FJTD8-7QH4S";
const SERVER = "https://license.example.dev";
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const hex = async (s: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("hex");
const nowS = () => Math.floor(Date.now() / 1000);

async function keys() {
	const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
	const priv = JSON.stringify(await crypto.subtle.exportKey("jwk", kp.privateKey));
	const sign = async (claims: Record<string, unknown>) => {
		const h = enc({ alg: "ES256", typ: "JWT" });
		const p = enc(claims);
		const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, new TextEncoder().encode(`${h}.${p}`));
		return `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
	};
	return { pub: { kty: "EC", crv: "P-256", x: pub.x, y: pub.y } as JsonWebKey, priv, sign };
}

/** A tiny stand-in for the license service's /v1 API that signs real tokens. */
async function fakeService(k: Awaited<ReturnType<typeof keys>>) {
	const calls: HttpRequest[] = [];
	let next: ((body: { key: string; device: string }) => Promise<HttpResponse> | HttpResponse) | null = null;
	const http = async (r: HttpRequest): Promise<HttpResponse> => {
		calls.push(r);
		const body = JSON.parse(r.body!) as { key: string; device: string };
		if (next) return next(body);
		const claims = { v: 1, aud: "cardsmith", plan: "pro", prv: "stripe", sub: (await hex(body.key)).slice(0, 24), dev: (await hex(`cardsmith-device:${body.device}`)).slice(0, 24), pe: nowS() + 86400 * 30, iat: nowS(), exp: nowS() + 7 * 86400 };
		return { status: 200, json: { ok: true, token: await k.sign(claims), periodEnd: claims.pe }, text: "" };
	};
	return { calls, http, reply: (f: typeof next) => (next = f) };
}

describe("config: payment rail flag", () => {
	it("defaults to Stripe, keeps Polar's link only behind the flag, and ships with placeholders", () => {
		expect(LICENSE_RAIL).toBe("stripe");
		expect(POLAR_PRO_PAGE_URL).toMatch(/^https:\/\/buy\.polar\.sh\//);
		expect(PRO_PAGE_URL).not.toContain("polar");
	});
});

describe("StripeLicenseProvider", () => {
	it("normalizes keys like the license service does", () => {
		expect(normalizeStripeKey(KEY)).toBe(KEY);
		expect(normalizeStripeKey(" cardsmith dj5jj mp6cx fjtd8 7qh4s ")).toBe(KEY);
		expect(normalizeStripeKey("CARDSMITH-OlABC-DEFGH-JKMNP-QRSTi")).toBe("CARDSMITH-01ABC-DEFGH-JKMNP-QRST1"); // O/I/L typos
		expect(normalizeStripeKey("CARDSMITH-DJ5JJ-MP6CX-FJTD8")).toBeNull();
		expect(normalizeStripeKey("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6abcd")).toBeNull(); // itch key stays with the itch rail
		expect(newDeviceId()).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(newDeviceId()).not.toBe(newDeviceId());
	});

	it("is off (no network, Pro 'not on sale') until the service URL is set", async () => {
		const k = await keys();
		const p = new StripeLicenseProvider(async () => { throw new Error("no network expected"); }, "", k.pub);
		expect(p.isConfigured()).toBe(false);
		await expect(p.activate(KEY)).rejects.toMatchObject({ kind: "unconfigured" });
	});

	it("activates with only {key, device, product}, stores the device id, and verifies offline", async () => {
		const k = await keys();
		const svc = await fakeService(k);
		const p = new StripeLicenseProvider(svc.http, SERVER + "/", k.pub);
		const g = await p.activate(KEY.toLowerCase());
		expect(svc.calls[0]!.url).toBe(`${SERVER}/v1/activate`);
		const sent = JSON.parse(svc.calls[0]!.body!);
		expect(Object.keys(sent).sort()).toEqual(["device", "key", "product"]);
		expect(sent).toMatchObject({ key: KEY, product: "cardsmith" });
		expect(g).toMatchObject({ source: "stripe", activationId: sent.device });
		expect(g.expiresAt).toBeGreaterThan(Date.now());
		const stored: StoredLicense = { key: KEY, providerId: "stripe", source: "stripe", activationId: g.activationId, token: g.token, expiresAt: g.expiresAt, lastValidatedAt: Date.now() };
		expect(await p.verifyOffline(stored)).toBe(true);
		// token is bound to the key, the device, and the time it was issued
		expect(await p.verifyOffline({ ...stored, activationId: newDeviceId() })).toBe(false);
		expect(await p.verifyOffline({ ...stored, key: "CARDSMITH-AAAAA-AAAAA-AAAAA-AAAAA" })).toBe(false);
		expect(await p.verifyOffline({ ...stored, lastValidatedAt: Date.now() + 3 * 86400_000 })).toBe(false);
		// validate reuses the same device id; deactivate frees it
		await p.validate(stored);
		expect(JSON.parse(svc.calls[1]!.body!).device).toBe(sent.device);
		await p.deactivate(stored);
		expect(svc.calls[2]!.url).toBe(`${SERVER}/v1/deactivate`);
	});

	it("rejects tokens from another key, another rail, or for another device", async () => {
		const k = await keys();
		const svc = await fakeService(k);
		const p = new StripeLicenseProvider(svc.http, SERVER, k.pub);
		const bad = async (claims: Record<string, unknown>) => ({ status: 200, json: { ok: true, token: await k.sign({ v: 1, aud: "cardsmith", plan: "pro", prv: "stripe", sub: "x", dev: "y", iat: nowS(), exp: nowS() + 99, ...claims }) }, text: "" });
		svc.reply(() => bad({}));
		await expect(p.activate(KEY)).rejects.toMatchObject({ kind: "server" });
		svc.reply(async (b) => bad({ prv: "itch", sub: (await hex(b.key)).slice(0, 24), dev: (await hex(`cardsmith-device:${b.device}`)).slice(0, 24) }));
		await expect(p.activate(KEY)).rejects.toMatchObject({ kind: "server" });
		const other = await keys();
		svc.reply(async (b) => ({ status: 200, json: { ok: true, token: await other.sign({ v: 1, aud: "cardsmith", plan: "pro", prv: "stripe", sub: (await hex(b.key)).slice(0, 24), dev: (await hex(`cardsmith-device:${b.device}`)).slice(0, 24), iat: nowS(), exp: nowS() + 99 }) }, text: "" }));
		await expect(p.activate(KEY)).rejects.toMatchObject({ kind: "server" });
	});

	it("maps service answers to license errors", async () => {
		const k = await keys();
		const svc = await fakeService(k);
		const p = new StripeLicenseProvider(svc.http, SERVER, k.pub);
		const cases: [HttpResponse, string][] = [
			[{ status: 200, json: { ok: false, code: "invalid", error: "That license key was not found." }, text: "" }, "invalid"],
			[{ status: 200, json: { ok: false, code: "inactive", error: "This Cardsmith Pro subscription was refunded" }, text: "" }, "invalid"],
			[{ status: 200, json: { ok: false, code: "limit", error: "already active on 3 devices" }, text: "" }, "limit"],
			[{ status: 429, json: { ok: false, code: "rate_limited" }, text: "" }, "rate_limited"],
			[{ status: 502, json: null, text: "" }, "server"],
		];
		for (const [res, kind] of cases) {
			svc.reply(() => res);
			const e = await p.activate(KEY).catch((x: unknown) => x);
			expect(e).toBeInstanceOf(LicenseError);
			expect((e as LicenseError).kind).toBe(kind);
		}
		const down = new StripeLicenseProvider(async () => { throw new Error("offline"); }, SERVER, k.pub);
		await expect(down.activate(KEY)).rejects.toMatchObject({ kind: "network" });
		await expect(p.activate("not a key")).rejects.toMatchObject({ kind: "invalid" });
	});

	it("through LicenseManager: refund turns Pro off, offline keeps it for 7 days, then pauses", async () => {
		const k = await keys();
		const svc = await fakeService(k);
		let t = Date.now();
		let stored: StoredLicense | null = null;
		let online = true;
		const http = async (r: HttpRequest) => {
			if (!online) throw new Error("offline");
			return svc.http(r);
		};
		const mk = () => new LicenseManager([new StripeLicenseProvider(http, SERVER, k.pub)], () => stored, async (l) => void (stored = l), () => t);
		expect((await mk().activate(KEY)).state).toBe("pro");
		online = false;
		t += 3 * 86400_000;
		expect(await mk().revalidate()).toMatchObject({ state: "pro", offline: true });
		t += 5 * 86400_000;
		expect((await mk().restore()).state).toBe("paused");
		online = true;
		svc.reply(() => ({ status: 200, json: { ok: false, code: "inactive", error: "This Cardsmith Pro subscription was refunded, so the key no longer unlocks Pro." }, text: "" }));
		expect(await mk().revalidate(true)).toMatchObject({ state: "free" });
		expect(stored).toBeNull();
	});
});

// Cross-check against the real license service code when it sits next to the plugin (prep workspace).
const SERVICE = "../../cardsmith-license-stripe/src/token.ts";
describe.skipIf(!existsSync(new URL(SERVICE, import.meta.url)))("plugin <-> Stripe license service token format", () => {
	it("a token signed by the service's own signToken() is accepted and bound", async () => {
		const { signToken } = (await import(SERVICE)) as { signToken: (jwk: string, c: { sub: string; dev: string; pe: number | null }, now: number) => Promise<string> };
		const k = await keys();
		const device = newDeviceId();
		const token = await signToken(k.priv, { sub: (await hex(KEY)).slice(0, 24), dev: (await hex(`cardsmith-device:${device}`)).slice(0, 24), pe: nowS() + 86400 }, nowS());
		const p = new StripeLicenseProvider(async () => ({ status: 200, json: { ok: true, token }, text: "" }), SERVER, k.pub);
		const stored: StoredLicense = { key: KEY, providerId: "stripe", source: "stripe", activationId: device, token, expiresAt: null, lastValidatedAt: Date.now() };
		expect(await p.verifyOffline(stored)).toBe(true);
	});
});
