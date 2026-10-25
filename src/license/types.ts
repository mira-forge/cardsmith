/**
 * Pro licensing sits behind a small provider interface so the payment rail can change
 * without touching feature code. Feature code only ever asks LicenseManager.isPro().
 *
 * Providers today (config.ts LICENSE_RAIL picks Stripe or Polar; itch is independent):
 *  - StripeLicenseProvider (default): CARDSMITH- keys from Stripe Payment Links, checked by
 *    the Mira Forge license service, which returns a signed token verified offline.
 *  - PolarLicenseProvider (fallback): subscription license keys checked directly against
 *    api.polar.sh's public, no-auth customer-portal endpoints. No Mira Forge server.
 *  - ServerLicenseProvider (secondary, off by default): itch.io download keys, which can
 *    only be checked server-side because itch's API key is secret.
 */

export interface LicenseGrant {
	/** Which payment rail issued it, e.g. "polar" or "itch". */
	source: string;
	/** Provider-side expiry (subscription period end), ms since epoch, or null for none/perpetual. */
	expiresAt: number | null;
	/** Device activation id, if the rail counts devices (Polar activation id, Stripe random device id). */
	activationId?: string;
	/** Signed token, if the rail issues one (the Mira Forge license services). */
	token?: string;
}

export type LicenseErrorKind = "invalid" | "network" | "rate_limited" | "server" | "limit" | "unconfigured";

export class LicenseError extends Error {
	constructor(
		public kind: LicenseErrorKind,
		message: string,
	) {
		super(message);
	}
}

/** Persisted license state (in the plugin's data.json). Holds no names, emails or other personal data. */
export interface StoredLicense {
	key: string;
	providerId: string;
	source: string;
	activationId?: string;
	token?: string;
	expiresAt: number | null;
	/** Last time the provider confirmed the key, ms since epoch. */
	lastValidatedAt: number;
}

export interface LicenseProvider {
	/** Stable id, stored with the license so re-checks go to the same provider. */
	readonly id: string;
	readonly label: string;
	/** Pro keeps working this long after the last successful check if the provider is unreachable. */
	readonly offlineGraceMs: number;
	/** False when the build has no configuration for this rail (placeholders not filled in). */
	isConfigured(): boolean;
	/** Whether this provider recognises the shape of a key the user pasted. */
	accepts(key: string): boolean;
	/** First use on this device. Throws LicenseError. */
	activate(key: string): Promise<LicenseGrant>;
	/** Re-check a stored license (cancellations and refunds revoke it). Throws LicenseError. */
	validate(stored: StoredLicense): Promise<LicenseGrant>;
	/** Optional extra offline check of stored state, e.g. a token signature. */
	verifyOffline?(stored: StoredLicense): Promise<boolean>;
	/** Optional: free this device's activation seat. */
	deactivate?(stored: StoredLicense): Promise<void>;
}
