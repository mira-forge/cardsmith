/**
 * Verifies license tokens offline with the server's public key (ECDSA P-256 / ES256).
 * Uses Web Crypto, which exists on desktop and mobile Obsidian, so no Node APIs.
 */

export interface TokenClaims {
	v: number;
	aud: string;
	plan: "pro";
	prv: string;
	sub: string; // hash of the license key, never the key itself
	iat: number; // seconds
	exp: number; // seconds
	dev?: string; // Stripe rail: hash of the random device id the token was issued to
	pe?: number | null; // Stripe rail: subscription period end, seconds
}

export function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
	const bin = atob(b64);
	const out = new Uint8Array(new ArrayBuffer(bin.length));
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
	return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

/** Returns the claims if the signature is valid and the audience matches; does not check expiry. */
export async function verifyToken(token: string, key: CryptoKey, audience: string): Promise<TokenClaims | null> {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const [h, p, s] = parts as [string, string, string];
	let header: { alg?: string };
	let claims: TokenClaims;
	try {
		header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h))) as { alg?: string };
		claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as TokenClaims;
	} catch {
		return null;
	}
	if (header.alg !== "ES256") return null;
	const ok = await crypto.subtle.verify(
		{ name: "ECDSA", hash: "SHA-256" },
		key,
		b64urlToBytes(s),
		new TextEncoder().encode(`${h}.${p}`),
	);
	if (!ok) return null;
	if (claims.aud !== audience || claims.plan !== "pro") return null;
	return claims;
}
