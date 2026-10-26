/**
 * Card model, parsing of model output, and Spaced Repetition plugin formatting.
 * Pure functions only: no Obsidian imports, so everything here is unit-tested.
 */

import { carryHistory, type CarryResult } from "./history";

export type CardType = "basic" | "reversed" | "cloze";

export interface Card {
	type: CardType;
	/** Question side (basic/reversed). For cloze cards: the full sentence with ==hidden== parts. */
	front: string;
	/** Answer side (basic/reversed). Empty for cloze. */
	back: string;
}

export const BLOCK_START = "%% cardsmith:start";
export const BLOCK_END = "%% cardsmith:end %%";

/** Strip ```json fences and surrounding chatter, return the first JSON value found. */
export function extractJson(raw: string): unknown {
	let text = raw.trim();
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence && fence[1]) text = fence[1].trim();
	try {
		return JSON.parse(text);
	} catch {
		// fall through to bracket scan
	}
	const starts = [text.indexOf("{"), text.indexOf("[")].filter((i) => i >= 0);
	if (starts.length === 0) throw new Error("The model did not return JSON.");
	const start = Math.min(...starts);
	const open = text[start];
	const close = open === "{" ? "}" : "]";
	const end = text.lastIndexOf(close);
	if (end <= start) throw new Error("The model returned incomplete JSON.");
	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {
		throw new Error("The model returned JSON that could not be read.");
	}
}

function clean(s: unknown): string {
	if (typeof s !== "string") return "";
	return s.replace(/\r\n?/g, "\n").trim();
}

/** Turn the model's JSON into validated cards. Unknown or empty entries are dropped. */
export function parseCards(raw: string, allowed: CardType[]): Card[] {
	const data = extractJson(raw);
	const list: unknown[] = Array.isArray(data)
		? data
		: data && typeof data === "object" && Array.isArray((data as { cards?: unknown }).cards)
			? ((data as { cards: unknown[] }).cards)
			: [];
	const out: Card[] = [];
	const seen = new Set<string>();
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const o = item as Record<string, unknown>;
		let type = (typeof o.type === "string" ? o.type.toLowerCase() : "basic") as CardType;
		if (!["basic", "reversed", "cloze"].includes(type)) type = "basic";
		let front = clean(o.front ?? o.question ?? o.text ?? o.q);
		let back = clean(o.back ?? o.answer ?? o.a);
		if (type === "cloze") {
			front = normalizeCloze(front);
			back = "";
			if (!/==[^=]+==/.test(front)) continue;
		} else if (!front || !back) {
			continue;
		}
		if (!allowed.includes(type)) {
			if (type === "cloze") continue;
			type = "basic";
		}
		const key = front.toLowerCase().replace(/\s+/g, " "); // same question twice = duplicate
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ type, front, back });
	}
	return out;
}

/** Accept {{c1::x}}, {{x}} or ==x== from the model and normalise to ==x==. */
export function normalizeCloze(text: string): string {
	return text
		.replace(/\{\{c\d+::([^}]+?)(?:::[^}]*)?\}\}/g, "==$1==")
		.replace(/\{\{([^}]+)\}\}/g, "==$1==");
}

function isMultiline(card: Card): boolean {
	return card.front.includes("\n") || card.back.includes("\n");
}

/** Escape separators that would break the Spaced Repetition plugin's inline syntax. */
function inline(s: string): string {
	return s.replace(/:::|::/g, (m) => m.split("").join("\u200b"));
}

/**
 * The Spaced Repetition plugin ends a multi-line card at the first empty line, so blank lines
 * inside a card would cut it short. Collapse them, and drop lines that are exactly `?` or `??`.
 */
function noBlankLines(s: string): string {
	return s
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l) => l.trim() !== "" && l.trim() !== "?" && l.trim() !== "??")
		.join("\n");
}

/**
 * Format one card in the Spaced Repetition plugin syntax:
 * basic `Q::A`, reversed `Q:::A`, multi-line `Q\n?\nA` / `Q\n??\nA`, cloze as a ==highlighted== line.
 */
export function formatCard(card: Card): string {
	if (card.type === "cloze") return card.front.replace(/\s*\n\s*/g, " ");
	if (isMultiline(card)) {
		const sep = card.type === "reversed" ? "??" : "?";
		return `${noBlankLines(card.front)}\n${sep}\n${noBlankLines(card.back)}`;
	}
	const sep = card.type === "reversed" ? ":::" : "::";
	return `${inline(card.front)}${sep}${inline(card.back)}`;
}

/** Build the managed block that is inserted into a note. */
export function buildBlock(cards: Card[], deckTag: string, sourceHash: string): string {
	const tag = deckTag.startsWith("#") ? deckTag : `#${deckTag}`;
	const body = cards.map(formatCard).join("\n\n");
	return `${BLOCK_START} hash=${sourceHash} %%\n${tag}\n\n${body}\n${BLOCK_END}`;
}

export interface BlockInfo {
	start: number;
	end: number;
	hash: string | null;
}

/** Locate an existing managed block in a note. */
export function findBlock(note: string): BlockInfo | null {
	const first = note.indexOf(BLOCK_START);
	if (first < 0) return null;
	const endIdx = note.indexOf(BLOCK_END, first);
	if (endIdx < 0) return null;
	// a start marker whose end marker was deleted must not swallow text up to a later block's end
	const start = note.lastIndexOf(BLOCK_START, endIdx);
	const header = note.slice(start, note.indexOf("\n", start) >= 0 ? note.indexOf("\n", start) : endIdx);
	const m = header.match(/hash=([a-f0-9]+)/);
	return { start, end: endIdx + BLOCK_END.length, hash: m && m[1] ? m[1] : null };
}

/** The note text without the managed block, used for hashing and as model input. */
export function stripBlock(note: string): string {
	const b = findBlock(note);
	if (!b) return note;
	return (note.slice(0, b.start) + note.slice(b.end)).replace(/\n{3,}/g, "\n\n").trimEnd();
}

/**
 * The new block for a note, with Spaced Repetition review history carried over from the
 * note's current block for every card that is still there.
 */
export function mergeBlock(note: string, block: string, keepUnmatched = false): CarryResult {
	const b = findBlock(note);
	return carryHistory(b ? note.slice(b.start, b.end) : null, block, keepUnmatched);
}

/** Replace the managed block (keeping review history of cards that stay), or append it at the end of the note. */
export function upsertBlock(note: string, block: string, keepUnmatched = false): string {
	const b = findBlock(note);
	if (b) return note.slice(0, b.start) + mergeBlock(note, block, keepUnmatched).block + note.slice(b.end);
	const base = note.replace(/\s+$/, "");
	return `${base}${base ? "\n\n" : ""}${block}\n`;
}

/** Small, stable, dependency-free hash (FNV-1a 32-bit) used to detect changed notes. */
export function hashText(text: string): string {
	let h = 0x811c9dc5;
	const s = text.replace(/\s+/g, " ").trim();
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}
