import { describe, expect, it } from "vitest";
import { PolarLicenseProvider, type PolarConfig } from "../src/license/polar-provider";
import { LicenseManager, REVALIDATE_AFTER_MS } from "../src/license/manager";
import type { HttpRequest, HttpResponse } from "../src/ai/providers";
import type { StoredLicense } from "../src/license/types";

const ORG = "1dbfc517-0bbf-4301-9ba8-555ca42b9737";
const BENEFIT = "5f0a4c1e-1111-4222-8333-444455556666";
const ACT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const KEY = "CARDSMITH-1234-ABCD-5678-EFGH";
const DAY = 24 * 60 * 60 * 1000;
const cfg: PolarConfig = { apiBase: "https://api.polar.sh", organizationId: ORG, benefitIds: [BENEFIT], keyPrefix: "CARDSMITH", deviceLabel: "Cardsmith for Obsidian (desktop)" };

const granted = (over: Record<string, unknown> = {}) => ({
	id: "k1", organization_id: ORG, benefit_id: BENEFIT, status: "granted", expires_at: "2026-11-25T00:00:00Z",
	customer: { email: "buyer@example.com", name: "Buyer" }, ...over,
});

/** Fake Polar: records every request; behaviour switchable per test. */
function fakePolar() {
	const calls: HttpRequest[] = [];
	const state = { mode: "ok" as "ok" | "revoked" | "offline" | "limit" | "noActivations" | "otherBenefit" | "500" };
	const http = async (r: HttpRequest): Promise<HttpResponse> => {
		calls.push(r);
		if (state.mode === "offline") throw new Error("ENOTFOUND");
		const body = JSON.parse(r.body ?? "{}") as Record<string, unknown>;
		if (state.mode === "500") return { status: 502, json: null, text: "" };
		if (body.key !== KEY || state.mode === "revoked") return { status: 404, json: { error: "ResourceNotFound", detail: "License key not found" }, text: "" };
		if (r.url.endsWith("/activate")) {
			if (state.mode === "limit") return { status: 403, json: { error: "NotPermitted", detail: "License key activation limit reached" }, text: "" };
			if (state.mode === "noActivations") return { status: 403, json: { error: "NotPermitted", detail: "License key does not support activations" }, text: "" };
			return { status: 200, json: { id: ACT, license_key_id: "k1", label: body.label, meta: {}, license_key: granted() }, text: "" };
		}
		if (r.url.endsWith("/validate")) {
			return { status: 200, json: granted(state.mode === "otherBenefit" ? { benefit_id: "99999999-0000-4000-8000-000000000000" } : {}), text: "" };
		}
		if (r.url.endsWith("/deactivate")) return { status: 204, json: null, text: "" };
		return { status: 404, json: null, text: "" };
	};
	return { http, calls, state };
}

function setup() {
	const polar = fakePolar();
	let stored: StoredLicense | null = null;
	let t = Date.parse("2026-10-25T12:00:00Z");
	const clock = { advance: (ms: number) => (t += ms) };
	const mgr = new LicenseManager([new PolarLicenseProvider(polar.http, cfg)], () => stored, async (l) => void (stored = l), () => t);
	return { polar, mgr, clock, get stored() { return stored; } };
}

describe("PolarLicenseProvider", () => {
	it("is off until an organization id is configured", () => {
		const p = new PolarLicenseProvider(fakePolar().http, { ...cfg, organizationId: "" });
		expect(p.isConfigured()).toBe(false);
		expect(new PolarLicenseProvider(fakePolar().http, cfg).isConfigured()).toBe(true);
	});
	it("accepts only keys with the configured prefix", () => {
		const p = new PolarLicenseProvider(fakePolar().http, cfg);
		expect(p.accepts(KEY)).toBe(true);
		expect(p.accepts("https://x.itch.io/y/download/abc")).toBe(false);
		expect(p.accepts("OTHER-123")).toBe(false);
	});
	it("activates once, stores the activation id and no personal data, talks only to api.polar.sh", async () => {
		const s = setup();
		const st = await s.mgr.activate(`  ${KEY} `);
		expect(st).toMatchObject({ state: "pro", source: "polar" });
		expect(s.stored).toMatchObject({ key: KEY, providerId: "polar", activationId: ACT, expiresAt: Date.parse("2026-11-25T00:00:00Z") });
		expect(JSON.stringify(s.stored)).not.toMatch(/buyer|example\.com/i);
		const req = s.polar.calls[0]!;
		expect(new URL(req.url).host).toBe("api.polar.sh");
		expect(req.url).toBe("https://api.polar.sh/v1/customer-portal/license-keys/activate");
		expect(JSON.parse(req.body!)).toEqual({ key: KEY, organization_id: ORG, label: "Cardsmith for Obsidian (desktop)" });
		expect(req.headers.authorization).toBeUndefined();
	});
	it("falls back to validate when the benefit has no device activations", async () => {
		const s = setup();
		s.polar.state.mode = "noActivations";
		expect((await s.mgr.activate(KEY)).state).toBe("pro");
		expect(s.polar.calls.map((c) => c.url.split("/").pop())).toEqual(["activate", "validate"]);
		expect(s.stored?.activationId).toBeUndefined();
	});
	it("reports the device limit and rejects unknown keys and other products", async () => {
		const s = setup();
		s.polar.state.mode = "limit";
		await expect(s.mgr.activate(KEY)).rejects.toMatchObject({ kind: "limit" });
		s.polar.state.mode = "ok";
		await expect(s.mgr.activate("CARDSMITH-WRONG-KEY-0000")).rejects.toMatchObject({ kind: "invalid" });
		s.polar.state.mode = "noActivations";
		const s2 = setup();
		s2.polar.state.mode = "otherBenefit";
		await expect(s2.mgr.activate(KEY)).resolves.toMatchObject({ state: "pro" }); // activate payload carries the right benefit
		s2.clock.advance(REVALIDATE_AFTER_MS + 1);
		expect((await s2.mgr.revalidate()).state).toBe("free"); // validate says another benefit
		expect(s.mgr.isPro()).toBe(false);
	});
});

describe("LicenseManager with Polar", () => {
	it("re-validates at most once a day, sending the activation id", async () => {
		const s = setup();
		await s.mgr.activate(KEY);
		s.clock.advance(6 * 60 * 60 * 1000);
		await s.mgr.revalidate();
		expect(s.polar.calls).toHaveLength(1); // still within 24h: no network
		s.clock.advance(DAY);
		await s.mgr.revalidate();
		expect(s.polar.calls).toHaveLength(2);
		expect(JSON.parse(s.polar.calls[1]!.body!)).toEqual({ key: KEY, organization_id: ORG, activation_id: ACT });
	});
	it("gives a 7-day offline grace, then pauses Pro (free keeps working), and resumes when back online", async () => {
		const s = setup();
		await s.mgr.activate(KEY);
		s.polar.state.mode = "offline";
		s.clock.advance(3 * DAY);
		expect(await s.mgr.revalidate()).toMatchObject({ state: "pro", offline: true });
		s.clock.advance(3 * DAY);
		expect(s.mgr.isPro()).toBe(true);
		expect((await s.mgr.restore()).state).toBe("pro");
		s.clock.advance(1.5 * DAY);
		expect((await s.mgr.revalidate()).state).toBe("paused");
		expect(s.mgr.isPro()).toBe(false);
		expect(s.stored).not.toBeNull(); // key kept, so Pro comes back without re-entering it
		s.polar.state.mode = "ok";
		expect((await s.mgr.revalidate()).state).toBe("pro");
	});
	it("a server error is treated like being offline, not as a revocation", async () => {
		const s = setup();
		await s.mgr.activate(KEY);
		s.polar.state.mode = "500";
		s.clock.advance(DAY + 1);
		expect((await s.mgr.revalidate()).state).toBe("pro");
		expect(s.stored).not.toBeNull();
	});
	it("a cancelled/refunded subscription (revoked key) returns to free on the next check", async () => {
		const s = setup();
		await s.mgr.activate(KEY);
		s.polar.state.mode = "revoked";
		s.clock.advance(DAY + 1);
		const st = await s.mgr.revalidate();
		expect(st.state).toBe("free");
		expect(s.stored).toBeNull();
	});
	it("removing the license frees the device seat", async () => {
		const s = setup();
		await s.mgr.activate(KEY);
		await s.mgr.remove();
		const last = s.polar.calls.at(-1)!;
		expect(last.url).toMatch(/\/deactivate$/);
		expect(JSON.parse(last.body!)).toEqual({ key: KEY, organization_id: ORG, activation_id: ACT });
		expect(s.mgr.isPro()).toBe(false);
	});
	it("a clock set backwards does not extend Pro", async () => {
		const s = setup();
		await s.mgr.activate(KEY);
		s.clock.advance(-10 * DAY);
		expect((await s.mgr.restore()).state).toBe("paused");
	});
	it("with nothing configured, activation says Pro is not on sale and nothing is sent", async () => {
		const polar = fakePolar();
		const mgr = new LicenseManager([new PolarLicenseProvider(polar.http, { ...cfg, organizationId: "" })], () => null, async () => {});
		expect(mgr.salesOpen()).toBe(false);
		await expect(mgr.activate(KEY)).rejects.toMatchObject({ kind: "unconfigured" });
		expect(polar.calls).toHaveLength(0);
	});
});
