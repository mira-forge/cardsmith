/**
 * Build-time configuration. Placeholders are filled in when a payment rail is approved
 * and set up; until then Pro shows as "coming soon" and the free tier is unaffected.
 */

/**
 * Where the "Get a license" button points for the Stripe rail: the live Cardsmith Pro Payment Link
 * (Stripe Managed Payments / Link checkout, opened in the browser). Empty = no button.
 */
export const STRIPE_PRO_PAGE_URL = "https://buy.stripe.com/cNifZg2KzcjZdg15O69Ve00";

/** Where the "Get a license" button points. */
export const PRO_PAGE_URL: string = STRIPE_PRO_PAGE_URL;

/**
 * Stripe rail: the Mira Forge license service (Cloudflare Worker). Empty = disabled, no network
 * use, and Pro shows as "not on sale yet". Deployed Oct 25 2026 (free workers.dev); may move to license.miraforge.dev later.
 */
export const STRIPE_LICENSE_SERVER_URL = "https://cardsmith-license-stripe.miraforge.workers.dev";

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
