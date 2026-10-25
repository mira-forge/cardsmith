import type { HttpFn } from "../ai/providers";
import { importPublicKey, verifyToken, type TokenClaims } from "./token";
import { LicenseError, type LicenseGrant, type LicenseProvider, type StoredLicense } from "./types";

export const STRIPE_TOKEN_AUDIENCE = "cardsmith";
/** Matches the license token lifetime: Pro keeps working offline for 7 days after the last check. */
export const STRIPE_OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** Tolerated device-vs-server clock difference when binding lastValidatedAt to the token. */
const CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Primary rail: Cardsmith Pro bought through Stripe Payment Links (Managed Payments,
 * sold through Link). The Mira Forge license service turns the subscription into a
 * CARDSMITH-XXXXX-XXXXX-XXXXX-XXXXX key and returns a short-lived ES256 token that the
 * plugin verifies offline with a bundled public key.
 *
 * Network use: POST {key, device, product} to the license service only. The device id
 * is random, generated on this device, and is not linked to any personal data.
 */
export class StripeLicenseProvider implements LicenseProvider {
	readonly id = "stripe";
	readonly label = "Cardsmith Pro subscription";
	readonly offlineGraceMs = STRIPE_OFFLINE_GRACE_MS;
	private key: CryptoKey | null = null;

	constructor(
		private http: HttpFn,
		private serverUrl: string,
		private publicJwk: JsonWebKey,
	) {}

	isConfigured(): boolean {
		return /^https:\/\//.test(this.serverUrl) && typeof this.publicJwk.x === "string" && !this.publicJwk.x.startsWith("__");
	}

	accepts(key: string): boolean {
		return normalizeStripeKey(key) !== null;
	}

	activate(key: string): Promise<LicenseGrant> {
		return this.call("/v1/activate", key, newDeviceId());
	}

	validate(stored: StoredLicense): Promise<LicenseGrant> {
		return this.call("/v1/validate", stored.key, stored.activationId || newDeviceId());
	}

	async deactivate(stored: StoredLicense): Promise<void> {
		const key = normalizeStripeKey(stored.key);
		if (!this.isConfigured() || !key || !stored.activationId) return;
		await this.http({
			url: this.endpoint("/v1/deactivate"),
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key, device: stored.activationId, product: "cardsmith" }),
		});
	}

	/**
	 * Token must be ours and bound to this key and device. The manager's 7-day grace runs from
	 * lastValidatedAt, so that timestamp must not be later than the token's issue time (stops a
	 * hand-edited data.json from stretching the offline window by more than a day).
	 */
	async verifyOffline(stored: StoredLicense): Promise<boolean> {
		const key = normalizeStripeKey(stored.key);
		if (!stored.token || !key || !stored.activationId) return false;
		const c = await verifyToken(stored.token, await this.publicKey(), STRIPE_TOKEN_AUDIENCE).catch(() => null);
		return !!c && (await this.bound(c, key, stored.activationId)) && stored.lastValidatedAt <= c.iat * 1000 + CLOCK_SKEW_MS;
	}

	private async bound(c: TokenClaims, key: string, device: string): Promise<boolean> {
		if (c.prv !== "stripe") return false;
		if (c.sub !== (await sha256hex(key)).slice(0, 24)) return false;
		return c.dev === (await sha256hex(`cardsmith-device:${device}`)).slice(0, 24);
	}

	private async publicKey(): Promise<CryptoKey> {
		if (!this.key) this.key = await importPublicKey(this.publicJwk);
		return this.key;
	}

	private endpoint(path: string): string {
		return this.serverUrl.replace(/\/+$/, "") + path;
	}

	private async call(path: string, rawKey: string, device: string): Promise<LicenseGrant> {
		if (!this.isConfigured()) throw new LicenseError("unconfigured", "Pro is not on sale yet.");
		const key = normalizeStripeKey(rawKey);
		if (!key) throw new LicenseError("invalid", "That does not look like a Cardsmith Pro license key.");
		let res;
		try {
			res = await this.http({
				url: this.endpoint(path),
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ key, device, product: "cardsmith" }),
			});
		} catch {
			throw new LicenseError("network", "Could not reach the license service. Pro keeps working offline for up to 7 days.");
		}
		const j = (res.json ?? {}) as { ok?: boolean; code?: string; token?: string; error?: string; periodEnd?: number | null };
		if (res.status === 429 || j.code === "rate_limited") throw new LicenseError("rate_limited", "Too many attempts. Wait a minute and try again.");
		if (res.status >= 500) throw new LicenseError("server", "The license service had a problem. Try again later.");
		if (j.code === "limit") throw new LicenseError("limit", j.error || "This key is already active on 3 devices. Remove it from one of them first.");
		if (!j.ok || !j.token) throw new LicenseError("invalid", j.error || "That license key was not recognised.");
		const claims = await verifyToken(j.token, await this.publicKey(), STRIPE_TOKEN_AUDIENCE);
		if (!claims || !(await this.bound(claims, key, device))) {
			throw new LicenseError("server", "The license service returned a token that failed verification.");
		}
		const pe = typeof j.periodEnd === "number" ? j.periodEnd : claims.pe;
		return { source: "stripe", expiresAt: typeof pe === "number" ? pe * 1000 : null, activationId: device, token: j.token };
	}
}

const KEY_BODY = /^[0-9A-HJKMNP-TV-Z]{20}$/;

/** Same rules as the license service: case, spaces and dashes don't matter; O, I and L read as 0, 1, 1. */
export function normalizeStripeKey(input: string): string | null {
	const raw = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
	if (!raw.startsWith("CARDSM1TH")) return null;
	const body = raw.slice("CARDSMITH".length);
	if (!KEY_BODY.test(body)) return null;
	return `CARDSMITH-${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10, 15)}-${body.slice(15, 20)}`;
}

/** Random per-install device id (24 random bytes, base64url). Not derived from hardware or the user. */
export function newDeviceId(): string {
	const b = crypto.getRandomValues(new Uint8Array(24));
	let s = "";
	for (const x of b) s += String.fromCharCode(x);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256hex(s: string): Promise<string> {
	const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
	return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}
