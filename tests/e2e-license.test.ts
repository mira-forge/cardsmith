import { describe, expect, it } from "vitest";
import { handle, resetRateLimits } from "../license-server/src/index";
import { ServerLicenseProvider } from "../src/license/server-provider";
import { LicenseManager } from "../src/license/manager";
import type { HttpFn } from "../src/ai/providers";
import type { StoredLicense } from "../src/license/types";

describe("plugin <-> license server (itch rail), end to end in-process", () => {
	it("a real server token is accepted by the plugin and survives a restart offline", async () => {
		resetRateLimits();
		const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
		const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
		const env = { ITCH_API_KEY: "s", ITCH_GAME_ID: "42", SIGNING_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", kp.privateKey)) };
		const itch: typeof fetch = async () => new Response(JSON.stringify({ download_key: { game_id: 42 } }));
		const http: HttpFn = async (r) => {
			const res = await handle(new Request(r.url, { method: r.method, headers: r.headers, body: r.body }), env, itch);
			return { status: res.status, json: await res.json(), text: "" };
		};
		let stored: StoredLicense | null = null;
		const mk = () => new LicenseManager([new ServerLicenseProvider(http, "https://license.example.dev", { kty: "EC", crv: "P-256", x: pub.x, y: pub.y })], () => stored, async (l) => void (stored = l));
		expect((await mk().activate("a".repeat(40))).state).toBe("pro");
		expect((await mk().restore()).state).toBe("pro");
	});
});
