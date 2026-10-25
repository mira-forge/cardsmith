import type { HttpFn } from "../ai/providers";
import { LicenseError, type LicenseGrant, type LicenseProvider, type StoredLicense } from "./types";

export interface PolarConfig {
	/** https://api.polar.sh (or https://sandbox-api.polar.sh for testing). */
	apiBase: string;
	/** Public organization id (a UUID). Not a secret. */
	organizationId: string;
	/** License-key benefit ids that unlock Pro. Empty = any key from the organization. */
	benefitIds: string[];
	/** Optional key prefix configured on the benefit, e.g. "CARDSMITH". */
	keyPrefix: string;
	/** Label stored with the activation on Polar's side, e.g. "Cardsmith desktop". No personal data. */
	deviceLabel: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const POLAR_OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Polar license keys, checked client-side against Polar's public customer-portal endpoints:
 *   POST /v1/customer-portal/license-keys/activate   (once per device; returns an activation id)
 *   POST /v1/customer-portal/license-keys/validate   (at most daily; key + activation id)
 *   POST /v1/customer-portal/license-keys/deactivate (when the user removes the key)
 * These endpoints need no API token; the key itself is the credential.
 * Only the key, the public organization id, the activation id and a generic device label are sent.
 * The response includes customer details; we read status/benefit/expiry and discard the rest.
 */
export class PolarLicenseProvider implements LicenseProvider {
	readonly id = "polar";
	readonly label = "Polar subscription";
	readonly offlineGraceMs = POLAR_OFFLINE_GRACE_MS;

	constructor(
		private http: HttpFn,
		private cfg: PolarConfig,
	) {}

	isConfigured(): boolean {
		return UUID.test(this.cfg.organizationId);
	}

	accepts(key: string): boolean {
		const k = key.trim();
		if (!k || /\s/.test(k) || k.includes("/")) return false;
		if (this.cfg.keyPrefix) return k.toUpperCase().startsWith(this.cfg.keyPrefix.toUpperCase());
		return k.length >= 16;
	}

	private url(path: string): string {
		return this.cfg.apiBase.replace(/\/+$/, "") + "/v1/customer-portal/license-keys/" + path;
	}

	private async post(path: string, body: Record<string, unknown>) {
		if (!this.isConfigured()) throw new LicenseError("unconfigured", "Pro subscriptions are not open yet.");
		try {
			return await this.http({
				url: this.url(path),
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		} catch {
			throw new LicenseError("network", "Could not reach Polar to check your license. Pro keeps working offline for up to 7 days.");
		}
	}

	/** Pull only what we need out of Polar's response; never keep customer fields. */
	private grantFrom(json: unknown, activationId?: string): LicenseGrant {
		const j = (json ?? {}) as {
			status?: string;
			organization_id?: string;
			benefit_id?: string;
			expires_at?: string | null;
		};
		if (j.status !== "granted") throw new LicenseError("invalid", "This license key is not active.");
		if (j.organization_id && j.organization_id !== this.cfg.organizationId) {
			throw new LicenseError("invalid", "This license key belongs to a different product.");
		}
		if (this.cfg.benefitIds.length && !this.cfg.benefitIds.includes(j.benefit_id ?? "")) {
			throw new LicenseError("invalid", "This license key is for a different product.");
		}
		const exp = j.expires_at ? Date.parse(j.expires_at) : NaN;
		return { source: "polar", expiresAt: Number.isFinite(exp) ? exp : null, activationId };
	}

	private fail(status: number, json: unknown): never {
		const detail = (json as { detail?: unknown } | null)?.detail;
		const text = typeof detail === "string" ? detail : "";
		if (status === 429) throw new LicenseError("rate_limited", "Too many attempts. Wait a minute and try again.");
		if (status >= 500) throw new LicenseError("server", "Polar had a problem. Try again later.");
		if (status === 403 && /limit/i.test(text)) {
			throw new LicenseError("limit", "This key is already active on the maximum number of devices. Remove it from another device first.");
		}
		if (status === 422) throw new LicenseError("invalid", "That does not look like a valid license key.");
		throw new LicenseError("invalid", "That license key was not found or is no longer active.");
	}

	async activate(key: string): Promise<LicenseGrant> {
		const k = key.trim();
		const res = await this.post("activate", { key: k, organization_id: this.cfg.organizationId, label: this.cfg.deviceLabel });
		if (res.status === 200) {
			const j = (res.json ?? {}) as { id?: string; license_key?: unknown };
			if (!j.id) throw new LicenseError("server", "Polar did not return an activation.");
			return this.grantFrom(j.license_key, j.id);
		}
		// Keys whose benefit has device activations turned off return 403 "does not support activations":
		// fall back to a plain validation, as Polar's docs recommend.
		const raw = (res.json as { detail?: unknown } | null)?.detail;
		const detail = typeof raw === "string" ? raw : "";
		if (res.status === 403 && /activation/i.test(detail) && !/limit/i.test(detail)) {
			return this.validateKey(k, undefined);
		}
		this.fail(res.status, res.json);
	}

	validate(stored: StoredLicense): Promise<LicenseGrant> {
		return this.validateKey(stored.key, stored.activationId);
	}

	private async validateKey(key: string, activationId: string | undefined): Promise<LicenseGrant> {
		const body: Record<string, unknown> = { key, organization_id: this.cfg.organizationId };
		if (activationId) body.activation_id = activationId;
		const res = await this.post("validate", body);
		if (res.status === 200) return this.grantFrom(res.json, activationId);
		this.fail(res.status, res.json);
	}

	async deactivate(stored: StoredLicense): Promise<void> {
		if (!stored.activationId) return;
		await this.post("deactivate", {
			key: stored.key,
			organization_id: this.cfg.organizationId,
			activation_id: stored.activationId,
		});
	}
}
