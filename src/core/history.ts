/**
 * Keeps Spaced Repetition review history when Cardsmith rewrites its block.
 *
 * The Spaced Repetition plugin stores each card's schedule right after the card, as
 * `<!--SR:!2026-11-02,7,250-->` on the next line (default), on the same line, or inside a
 * `> [!sr|card-metadata]` callout. When Cardsmith replaces its block, every card that is still
 * there gets its old schedule back, matched on normalized card text: first on question and answer,
 * then on the question alone (so an edited answer keeps its history). Cards that are gone lose theirs.
 * Pure functions only, no Obsidian imports.
 */
import { parseSrCards } from "./anki";

const SR_INLINE = /\s?<!--SR:!.+?-->/;
const BLOCK_ID_END = / (\^[a-zA-Z0-9-]+)$/;
const SR_CALLOUT = "> [!sr|card-metadata]";

interface History {
	/** Lines written after the card (next-line comment or callout), verbatim. */
	lines: string[];
	/** Comment written on the card's own last line, e.g. ` <!--SR:!...-->` (same-line setting). */
	sameLine: string;
	/** Obsidian block id on the card's last line, e.g. `^abc` (SR keeps schedules next to it). */
	blockId: string;
}

interface Entry {
	/** First and last line of the card text (in the body's line array). */
	first: number;
	last: number;
	full: string; // normalized front + back
	front: string; // normalized front
	history: History | null;
}

function norm(s: string): string {
	return s.replace(/\u200b/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function isSrLine(line: string): boolean {
	const t = line.trimStart();
	return t.startsWith("<!--SR:") || t.startsWith(SR_CALLOUT);
}

/** Walk the lines of a block body and return each card with any review history that follows it. */
function scan(lines: string[]): Entry[] {
	const out: Entry[] = [];
	let pending: number[] = []; // line numbers of the paragraph being collected
	let last: Entry | null = null; // the card the next SR line belongs to

	const toEntry = (idx: number[]): Entry | null => {
		if (!idx.length) return null;
		let blockId = "";
		let sameLine = "";
		const text = idx.map((i, k) => {
			let l = lines[i] ?? "";
			if (k === idx.length - 1) {
				const m = l.match(SR_INLINE);
				if (m && m.index !== undefined) {
					sameLine = l.slice(m.index);
					l = l.slice(0, m.index);
				}
				const b = l.trimEnd().match(BLOCK_ID_END);
				if (b && b[1] && !sameLine) {
					blockId = b[1];
					l = l.trimEnd().slice(0, -b[0].length);
				}
			}
			return l;
		});
		const cards = parseSrCards(text.join("\n"));
		if (cards.length !== 1) return null;
		const c = cards[0]!;
		const e: Entry = {
			first: idx[0]!,
			last: idx[idx.length - 1]!,
			full: norm(`${c.front}\n${c.back}`),
			front: norm(c.front),
			history: sameLine || blockId ? { lines: [], sameLine, blockId } : null,
		};
		return e;
	};
	const flush = (): Entry | null => {
		const e = toEntry(pending);
		pending = [];
		if (e) out.push(e);
		return e;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (isSrLine(line)) {
			const target = pending.length ? flush() : last;
			const hist: string[] = [line];
			if (line.trimStart().startsWith(SR_CALLOUT)) {
				// callout: take the quoted lines up to the one holding the comment
				while (i + 1 < lines.length && (lines[i + 1] ?? "").startsWith(">")) {
					hist.push(lines[++i] ?? "");
					if (hist[hist.length - 1]!.includes("<!--SR:")) break;
				}
			}
			if (target) {
				const h = target.history ?? { lines: [], sameLine: "", blockId: "" };
				h.lines.push(...hist);
				target.history = h;
			}
			last = null;
			continue;
		}
		if (line.trim() === "" || line.trim().startsWith("%%")) {
			flush();
			last = null;
			continue;
		}
		if (line.replace(/\u200b/g, "").indexOf("::") > 0) {
			// single-line card: its own card, whatever came before it in the paragraph
			flush();
			pending = [i];
			last = flush();
			continue;
		}
		pending.push(i);
		last = null;
	}
	flush();
	return out;
}

function hasHistory(h: History | null): h is History {
	return !!h && (h.lines.length > 0 || h.sameLine !== "");
}

export interface CarryResult {
	/** The new block with review history re-attached. */
	block: string;
	/** Cards in the new block that got their review history back. */
	kept: number;
	/** Cards with review history in the old block that are not in the new block. */
	dropped: number;
}

/**
 * Re-attach review history from `oldBlock` to the matching cards in `newBlock`.
 * Both are full managed blocks (start marker to end marker). Lines that are not cards are left alone.
 */
export function carryHistory(oldBlock: string | null, newBlock: string): CarryResult {
	if (!oldBlock) return { block: newBlock, kept: 0, dropped: 0 };
	// cards with a schedule, or with a block id that other notes may link to
	const oldEntries = scan(oldBlock.replace(/\r\n?/g, "\n").split("\n")).filter((e) => e.history !== null);
	if (!oldEntries.length) return { block: newBlock, kept: 0, dropped: 0 };
	const lines = newBlock.split("\n");
	const fresh = scan(lines);
	const used = new Set<Entry>();
	const pick = (pred: (o: Entry) => boolean) => oldEntries.find((o) => !used.has(o) && pred(o));
	const matches = new Map<Entry, Entry>();
	// exact question + answer first, then question only
	for (const n of fresh) {
		const o = pick((x) => x.full === n.full);
		if (o) {
			used.add(o);
			matches.set(n, o);
		}
	}
	for (const n of fresh) {
		if (matches.has(n)) continue;
		const o = pick((x) => x.front === n.front);
		if (o) {
			used.add(o);
			matches.set(n, o);
		}
	}
	// apply bottom-up so line numbers stay valid
	const ordered = [...matches.entries()].sort((a, b) => b[0].last - a[0].last);
	for (const [n, o] of ordered) {
		const h = o.history!;
		let lastLine = (lines[n.last] ?? "").trimEnd();
		if (h.sameLine) lastLine += h.sameLine.startsWith(" ") ? h.sameLine : ` ${h.sameLine}`;
		else if (h.blockId) lastLine += ` ${h.blockId}`;
		lines[n.last] = lastLine;
		if (h.lines.length) lines.splice(n.last + 1, 0, ...h.lines);
	}
	const kept = [...matches.values()].filter((o) => hasHistory(o.history)).length;
	const dropped = oldEntries.filter((o) => !used.has(o) && hasHistory(o.history)).length;
	return { block: lines.join("\n"), kept, dropped };
}
