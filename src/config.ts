/**
 * Build-time configuration. Placeholders are filled in when a payment rail is approved
 * and set up; until then Pro shows as "coming soon" and the free tier is unaffected.
 */

/**
 * Which payment rail this build uses. Exactly one is active, because both issue
 * CARDSMITH-prefixed keys. "stripe" (default): Stripe Payment Links with Managed Payments,
 * sold through Link, checked by the Mira Forge license service. "polar": the original
 * Polar rail, kept intact as a fallback.
 */
export type LicenseRail = "stripe" | "polar";
export const LICENSE_RAIL = "stripe" as LicenseRail;

/** Polar checkout link, used only when LICENSE_RAIL is "polar". */
export const POLAR_PRO_PAGE_URL = "https://buy.polar.sh/polar_cl_D3ozPl07ac9pfNLzRSTsG9TGrprfa7jUBCUjN0uSgAc";

/**
 * Where the "Get a license" button points for the Stripe rail: the Mira Forge pricing page,
 * which links to the monthly and yearly Payment Links. Empty = no button.
 * PLACEHOLDER until the Stripe account and Payment Links exist: "https://miraforge.dev/cardsmith#pricing".
 */
export const STRIPE_PRO_PAGE_URL = "";

/** Where the "Get Pro" button points for the active rail. */
export const PRO_PAGE_URL: string = LICENSE_RAIL === "polar" ? POLAR_PRO_PAGE_URL : STRIPE_PRO_PAGE_URL;

/**
 * Stripe rail: the Mira Forge license service (Cloudflare Worker). Empty = disabled, no network
 * use, and Pro shows as "not on sale yet". Deployed Oct 25 2026 (free workers.dev); may move to license.miraforge.dev later.
 */
export const STRIPE_LICENSE_SERVER_URL = "https://cardsmith-license-stripe.miraforge.workers.dev";

/** Fallback rail: Polar (active only when LICENSE_RAIL is "polar"). All public values, no secrets. */
export const POLAR = {
	apiBase: "https://api.polar.sh",
	organizationId: "a79f6574-80d0-4f20-82b2-7c9f2d9953ef", // e.g. "1dbfc517-0bbf-4301-9ba8-555ca42b9737"
	benefitIds: ["896abdeb-3301-41a0-8103-5e10a9373f48"] as string[], // license-key benefit id(s) attached to the Pro products
	productIds: ["30203190-7ed4-4215-904c-ca06b525ecd9", "3acef96e-0265-4f81-afbf-4bf85fa1fc8e"] as string[], // Pro monthly / yearly product ids (for reference and checkout links)
	keyPrefix: "CARDSMITH",
	deviceLabel: "Cardsmith for Obsidian",
};

/** Secondary rail: itch.io via the Mira Forge license server. Empty = disabled (no network use). */
export const ITCH_LICENSE_SERVER_URL = "";

/** Public half of the license service's ES256 signing key. Used by the Stripe and itch rails. Safe to ship; it can only verify. */
export const LICENSE_PUBLIC_JWK: JsonWebKey = {
	kty: "EC",
	crv: "P-256",
	x: "w2-myN4C5kWeroPRXAGEFF54JBNRfj9TZMZ3uVNQx34",
	y: "wiL7U57IB6ElD4oURWiqOWPzZhTtVzB3x9lCIBuYCg4",
};

export const FREE_MAX_CARDS = 10;
export const PRO_MAX_CARDS = 50;
