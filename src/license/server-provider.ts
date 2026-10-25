import type { HttpFn } from "../ai/providers";
import { importPublicKey, verifyToken } from "./token";
import { LicenseError, type LicenseGrant, type LicenseProvider, type StoredLicense } from "./types";

export const TOKEN_AUDIENCE = "cardsmith";
/** itch.io sales are one-time and perpetual, so be generous when our server is unreachable. */
export const ITCH_OFFLINE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Secondary rail: itch.io download keys, verified by the Mira Forge license server
 * (itch's API key is secret, so this check cannot run in the plugin). The server
 * returns a short-lived ES256 token that the plugin verifies offline with a bundled
 * public key. Disabled unless the build sets a server URL.
 */
export class ServerLicenseProvider implements LicenseProvider {
	readonly id = "itch";
	readonly label = "itch.io purchase";
	readonly offlineGraceMs = ITCH_OFFLINE_GRACE_MS;
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
		const k = key.trim();
		return /itch\.io\/.+\/download\//.test(k) || /^[A-Za-z0-9_-]{32,64}$/.test(k);
	}

	private async publicKey(): Promise<CryptoKey> {
		if (!this.key) this.key = await importPublicKey(this.publicJwk);
		return this.key;
	}

	activate(key: string): Promise<LicenseGrant> {
		return this.call("/v1/activate", key);
	}

	validate(stored: StoredLicense): Promise<LicenseGrant> {
		return this.call("/v1/validate", stored.key);
	}

	async verifyOffline(stored: StoredLicense): Promise<boolean> {
		if (!stored.token) return false;
		const claims = await verifyToken(stored.token, await this.publicKey(), TOKEN_AUDIENCE).catch(() => null);
		return !!claims;
	}

	private async call(path: string, key: string): Promise<LicenseGrant> {
		if (!this.isConfigured()) throw new LicenseError("unconfigured", "itch.io licenses are not enabled in this version.");
		let res;
		try {
			res = await this.http({
				url: this.serverUrl.replace(/\/+$/, "") + path,
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ key: normalizeItchKey(key), product: "cardsmith" }),
			});
		} catch {
			throw new LicenseError("network", "Could not reach the license server. Pro keeps working offline.");
		}
		const j = (res.json ?? {}) as { ok?: boolean; token?: string; error?: string };
		if (res.status === 429) throw new LicenseError("rate_limited", "Too many attempts. Wait a minute and try again.");
		if (res.status >= 500) throw new LicenseError("server", "The license server had a problem. Try again later.");
		if (!j.ok || !j.token) throw new LicenseError("invalid", j.error || "That license key was not recognised.");
		const claims = await verifyToken(j.token, await this.publicKey(), TOKEN_AUDIENCE);
		if (!claims) throw new LicenseError("server", "The license server returned a token that failed verification.");
		return { source: "itch", expiresAt: null, token: j.token };
	}
}

/** Accept a bare key or a pasted itch.io download page URL and return the key. */
export function normalizeItchKey(input: string): string {
	const t = input.trim();
	const m = t.match(/\/download\/([A-Za-z0-9_-]{16,})/);
	if (m && m[1]) return m[1];
	return t.replace(/\s+/g, "");
}
