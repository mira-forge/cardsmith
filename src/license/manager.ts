import { LicenseError, type LicenseProvider, type StoredLicense } from "./types";

/** Re-check with the provider at most once a day. */
export const REVALIDATE_AFTER_MS = 24 * 60 * 60 * 1000;

export type LicenseStatus =
	| { state: "free"; message?: string }
	| { state: "pro"; source: string; expiresAt: number | null; offline: boolean }
	/** Licensed, but offline longer than the grace period: Pro pauses until the next successful check. */
	| { state: "paused"; source: string };

/**
 * Holds the license and answers isPro(). Never throws into feature code, and nothing
 * here can disable the free tier: every failure path ends in "free" or "paused".
 */
export class LicenseManager {
	private status: LicenseStatus = { state: "free" };

	constructor(
		/** In priority order; the first configured provider that accepts a key is used. */
		private providers: LicenseProvider[],
		private load: () => StoredLicense | null,
		private save: (l: StoredLicense | null) => Promise<void>,
		private now: () => number = () => Date.now(),
	) {}

	isPro(): boolean {
		return this.status.state === "pro";
	}

	getStatus(): LicenseStatus {
		return this.status;
	}

	/** True if any rail is configured in this build (otherwise the UI says Pro is coming soon). */
	salesOpen(): boolean {
		return this.providers.some((p) => p.isConfigured());
	}

	private byId(id: string): LicenseProvider | undefined {
		return this.providers.find((p) => p.id === id);
	}

	/** Offline check on plugin load. No network. */
	async restore(): Promise<LicenseStatus> {
		const l = this.load();
		if (!l) return this.set({ state: "free" });
		const p = this.byId(l.providerId);
		if (!p) return this.set({ state: "free" });
		if (p.verifyOffline && !(await p.verifyOffline(l).catch(() => false))) return this.set({ state: "free" });
		const age = this.now() - l.lastValidatedAt;
		if (age < 0) return this.set({ state: "paused", source: l.source }); // clock moved backwards; re-check online
		if (age <= REVALIDATE_AFTER_MS) return this.set({ state: "pro", source: l.source, expiresAt: l.expiresAt, offline: false });
		if (age <= p.offlineGraceMs) return this.set({ state: "pro", source: l.source, expiresAt: l.expiresAt, offline: true });
		return this.set({ state: "paused", source: l.source });
	}

	async activate(rawKey: string): Promise<LicenseStatus> {
		const key = rawKey.trim();
		const candidates = this.providers.filter((p) => p.isConfigured() && p.accepts(key));
		if (!candidates.length) {
			throw new LicenseError(this.salesOpen() ? "invalid" : "unconfigured", this.salesOpen() ? "That does not look like a Cardsmith license key." : "Pro is not on sale yet.");
		}
		let last: unknown = null;
		for (const p of candidates) {
			try {
				const g = await p.activate(key);
				await this.save({
					key,
					providerId: p.id,
					source: g.source,
					activationId: g.activationId,
					token: g.token,
					expiresAt: g.expiresAt,
					lastValidatedAt: this.now(),
				});
				return this.set({ state: "pro", source: g.source, expiresAt: g.expiresAt, offline: false });
			} catch (e) {
				last = e;
				// Only try the next rail if this one said "not mine"; real errors stop here.
				if (!(e instanceof LicenseError && e.kind === "invalid")) break;
			}
		}
		throw last instanceof LicenseError ? last : new LicenseError("server", "Could not activate the license.");
	}

	/** Daily re-check. A revoked key (cancelled, refunded) turns Pro off; being offline does not, until the grace runs out. */
	async revalidate(force = false): Promise<LicenseStatus> {
		const l = this.load();
		if (!l) return this.set({ state: "free" });
		if (!force && this.now() - l.lastValidatedAt < REVALIDATE_AFTER_MS && this.now() >= l.lastValidatedAt) return this.restore();
		const p = this.byId(l.providerId);
		if (!p) return this.set({ state: "free" });
		try {
			const g = await p.validate(l);
			await this.save({
				...l,
				source: g.source,
				activationId: g.activationId ?? l.activationId,
				token: g.token ?? l.token,
				expiresAt: g.expiresAt,
				lastValidatedAt: this.now(),
			});
			return this.set({ state: "pro", source: g.source, expiresAt: g.expiresAt, offline: false });
		} catch (e) {
			if (e instanceof LicenseError && e.kind === "invalid") {
				await this.save(null);
				return this.set({ state: "free", message: e.message });
			}
			return this.restore();
		}
	}

	async remove(): Promise<LicenseStatus> {
		const l = this.load();
		if (l) await this.byId(l.providerId)?.deactivate?.(l).catch(() => undefined);
		await this.save(null);
		return this.set({ state: "free" });
	}

	private set(s: LicenseStatus): LicenseStatus {
		this.status = s;
		return s;
	}
}
