/**
 * Hosted generation (Cardsmith Pro, "no key needed"). Opt-in: only used when the user picks
 * "Hosted (Pro, no key needed)" as the model provider.
 *
 * Network use: POST to the Mira Forge license service (/v1/generate) with the license key, this
 * device's random id, the note title, the note text (at most 24,000 characters), the card count and
 * the card types. The service builds the prompt, picks the model and sends the request through
 * OpenRouter to Google Vertex only (no training, no fallback; Google may keep
 * requests briefly for abuse monitoring). It stores counters only (key hash, monthly count, cost),
 * never the note. Custom instructions and the card language setting are not sent in hosted mode.
 * Nothing is sent before the user accepts the one-time consent screen (HOSTED_CONSENT).
 */
import type { HttpFn } from "./providers";
import type { CardType } from "../core/cards";
import { MAX_INPUT_CHARS } from "../core/prompt";
import { HOSTED_HOURLY_GENS, HOSTED_MONTHLY_BUDGET_USD, HOSTED_MONTHLY_GENS } from "../config";

export const HOSTED_PRESET = "hosted";
export const HOSTED_LABEL = "Hosted (Pro, no key needed)";
export const MAX_TITLE_CHARS = 300;
/**
 * Client-side wait for /v1/generate. Must stay LONGER than the server's provider timeout (90 s, Worker
 * LIMITS.providerTimeoutMs) so the server always settles and answers first; a 50-card request can take ~1 min.
 */
export const HOSTED_CLIENT_TIMEOUT_MS = 100_000;

export interface HostedUsage {
	plan: "pro" | "trial";
	used: number;
	limit: number;
	remaining: number;
	/** ms since epoch (start of next month, UTC); null while the subscription is in a free trial (no hosted generations). */
	resetsAt: number | null;
}

export type HostedErrorCode = "needs_pro" | "wrong_license" | "declined" | "quota" | "auth" | "server" | "network" | "unconfigured";

export class HostedError extends Error {
	constructor(
		public code: HostedErrorCode,
		message: string,
		/** True when retrying the next note would fail the same way (folder runs stop). */
		public stop: boolean,
		public usage?: HostedUsage,
	) {
		super(message);
	}
}

const SWITCH = "Settings → Cardsmith → Model provider";
const MAX_CHARS = MAX_INPUT_CHARS.toLocaleString("en-US");

/**
 * One-time consent screen, shown before the first hosted request. Nothing is sent unless the user accepts.
 * Every claim here is checked against code in tests/hosted.test.ts (claim check) and the license service.
 */
export const HOSTED_CONSENT = {
	title: "Use hosted generation?",
	intro: "Hosted mode makes cards without your own API key. Before you start, here is what happens to your note.",
	items: [
		`What is sent: the note's title, its text (up to the first ${MAX_CHARS} characters), how many cards you want and which card types, plus your license key and this device's random ID. Custom instructions and the card language setting are not sent.`,
		"Who gets it: the Cardsmith service (Mira Forge's license server on Cloudflare) builds the request and sends the title and text through OpenRouter to Google's Gemini model, which writes the cards.",
		"Retention: Requests go through OpenRouter with no training, only to Google Vertex, with no fallback. Google may keep them briefly for abuse monitoring. The Cardsmith service doesn't store or log your note, its title or the cards.",
		"What is kept: only counters per license, stored under a hash of your key: generations and AI cost this month. A per-network hourly counter uses a keyed hash, not your IP address.",
		`Limits: ${HOSTED_MONTHLY_GENS} generations a month and ${HOSTED_HOURLY_GENS} an hour per license, and $${HOSTED_MONTHLY_BUDGET_USD.toFixed(2)} of AI cost a month, so very long notes or answers can use it up sooner. Hosted generation isn't included during a free trial and can be paused for everyone if the service's monthly spending limit is reached.`,
		`Switch back any time: pick your own key or Ollama in ${SWITCH}. Those requests go straight from this device to that provider and skip our server.`,
	],
	accept: "Use hosted generation",
	cancel: "Cancel",
} as const;
/** User-facing copy. Numbers come from config (they must match the license service's limits). */
export const HOSTED_COPY = {
	firstUse: "Hosted mode sends the note's title and text to the Cardsmith service, which passes them through OpenRouter to Google Vertex with no training and no fallback. Google may keep them briefly for abuse monitoring. Cardsmith keeps only usage counters, never your note. Your own key or Ollama skip our server.",
	declined: `Nothing was sent. To make cards without hosted mode, pick your own key or Ollama in ${SWITCH}.`,
	needsPro: `Hosted generation is part of Cardsmith Pro. Without Pro, use your own API key or a local Ollama model for free in ${SWITCH}.`,
	wrongLicense: `Hosted generation needs a Cardsmith Pro subscription key (CARDSMITH-…). Your own key or Ollama work for free in ${SWITCH}.`,
	gens: `You've used this month's ${HOSTED_MONTHLY_GENS} hosted generations (resets on the 1st). Keep going for free with your own key or Ollama in ${SWITCH}.`,
	cost: `You've used this month's hosted generation budget (resets on the 1st). Keep going for free with your own key or Ollama in ${SWITCH}.`,
	hourly: `Hosted generation is limited to ${HOSTED_HOURLY_GENS} an hour. Try again after the top of the hour, or use your own key or Ollama in ${SWITCH}.`,
	trial: `Hosted generation isn't included in a free trial. It turns on when your subscription's first payment goes through. Meanwhile, use your own key or Ollama in ${SWITCH}.`,
	paused: `Hosted generation is paused right now. Your own key or Ollama still work for free in ${SWITCH}.`,
	busy: `Too many hosted requests from this network. Try again in an hour, or use your own key or Ollama in ${SWITCH}.`,
	server: `The hosted AI had a problem making cards. Try again in a minute, or use your own key or Ollama in ${SWITCH}.`,
	timeout: `The hosted AI took too long to answer. Try again, make fewer cards at once, or use your own key or Ollama in ${SWITCH}.`,
	network: `Could not reach the Cardsmith service. Check your connection, or use a local Ollama model in ${SWITCH}.`,
	unconfigured: `Hosted generation isn't available in this build. Use your own key or Ollama in ${SWITCH}.`,
} as const;

type QuotaReason = "gens" | "cost" | "hourly" | "trial" | "paused" | "busy";
const QUOTA_REASONS: readonly QuotaReason[] = ["gens", "cost", "hourly", "trial", "paused", "busy"];

export interface HostedRequest {
	key: string;
	device: string;
	title: string;
	text: string;
	cards: number;
	types: CardType[];
}

function endpoint(serverUrl: string, path: string): string {
	if (!/^https:\/\//.test(serverUrl)) throw new HostedError("unconfigured", HOSTED_COPY.unconfigured, true);
	return serverUrl.replace(/\/+$/, "") + path;
}

function readUsage(u: unknown): HostedUsage | undefined {
	const o = u as Partial<HostedUsage> | null;
	if (!o || typeof o.remaining !== "number" || typeof o.limit !== "number" || typeof o.used !== "number") return undefined;
	return { plan: o.plan === "trial" ? "trial" : "pro", used: o.used, limit: o.limit, remaining: o.remaining, resetsAt: typeof o.resetsAt === "number" ? o.resetsAt : null };
}

/** Cut the note to what the service accepts. */
export function hostedText(text: string): { text: string; truncated: boolean } {
	return text.length > MAX_INPUT_CHARS ? { text: text.slice(0, MAX_INPUT_CHARS), truncated: true } : { text, truncated: false };
}

function toError(status: number, j: { code?: string; reason?: string; error?: string; usage?: unknown }): HostedError {
	const usage = readUsage(j.usage);
	if (status === 429 && j.code === "hosted_quota") {
		const r = QUOTA_REASONS.includes(j.reason as QuotaReason) ? (j.reason as QuotaReason) : "paused";
		return new HostedError("quota", HOSTED_COPY[r], true, usage);
	}
	if (status === 403 || status === 400) {
		// license problems (not found, ended, device not activated): the service's message names the fix
		return new HostedError("auth", `${j.error || "The license could not be used for hosted generation."} Your own key or Ollama work for free in ${SWITCH}.`, true, usage);
	}
	if (status === 413) return new HostedError("server", `Notes are limited to ${MAX_INPUT_CHARS.toLocaleString("en-US")} characters for hosted generation.`, false, usage);
	return new HostedError("server", HOSTED_COPY.server, status >= 500 && status !== 502, usage);
}

export async function hostedGenerate(http: HttpFn, serverUrl: string, r: HostedRequest, timeoutMs = HOSTED_CLIENT_TIMEOUT_MS): Promise<{ text: string; usage?: HostedUsage }> {
	const url = endpoint(serverUrl, "/v1/generate");
	const body = {
		key: r.key,
		device: r.device,
		product: "cardsmith",
		title: r.title.slice(0, MAX_TITLE_CHARS),
		text: hostedText(r.text).text,
		cards: r.cards,
		types: r.types,
		model: "auto",
	};
	let res;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const TIMED_OUT = Symbol("timeout");
	try {
		// Obsidian's requestUrl can't be aborted, so stop waiting instead (the server still settles the call).
		const t = new Promise<typeof TIMED_OUT>((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)));
		const r2 = await Promise.race([http({ url, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), t]);
		if (r2 === TIMED_OUT) throw new HostedError("network", HOSTED_COPY.timeout, true);
		res = r2;
	} catch (e) {
		if (e instanceof HostedError) throw e;
		throw new HostedError("network", HOSTED_COPY.network, true);
	} finally {
		clearTimeout(timer);
	}
	const j = (res.json ?? {}) as { ok?: boolean; text?: string; code?: string; reason?: string; error?: string; usage?: unknown };
	if (res.status === 200 && j.ok && typeof j.text === "string") return { text: j.text, usage: readUsage(j.usage) };
	throw toError(res.status, j);
}

export async function hostedUsage(http: HttpFn, serverUrl: string, key: string, device: string): Promise<{ available: boolean; usage?: HostedUsage }> {
	const url = endpoint(serverUrl, "/v1/hosted-usage");
	let res;
	try {
		res = await http({ url, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, device, product: "cardsmith" }) });
	} catch {
		throw new HostedError("network", HOSTED_COPY.network, true);
	}
	const j = (res.json ?? {}) as { ok?: boolean; available?: boolean; code?: string; reason?: string; error?: string; usage?: unknown };
	if (res.status === 200 && j.ok) return { available: j.available !== false, usage: readUsage(j.usage) };
	throw toError(res.status, j);
}

/** "287 of 300 hosted generations left this month (resets Dec 1)." */
export function usageText(u: HostedUsage | null | undefined): string {
	if (!u) return `Up to ${HOSTED_MONTHLY_GENS} generations a month, ${HOSTED_HOURLY_GENS} an hour.`;
	const n = `${u.remaining} of ${u.limit} hosted ${u.limit === 1 ? "generation" : "generations"}`;
	if (u.plan === "trial") return "Hosted generation turns on when your subscription's first payment goes through.";
	const reset = u.resetsAt ? ` (resets ${new Date(u.resetsAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })})` : "";
	return `${n} left this month${reset}.`;
}
