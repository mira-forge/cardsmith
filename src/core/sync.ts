/**
 * "Keep this folder in sync" (Pro): bookkeeping that finds notes in the synced folders that
 * changed since their cards were made, or that have no cards yet.
 *
 * Startup stays cheap: a note is read only when its modified time or size differs from what
 * was recorded the last time it was checked. Unchanged notes are answered from the record in
 * the plugin's data.json. Only notes in the synced folders are listed (see scope.ts).
 * Pure functions only, no Obsidian imports.
 */
import { findBlock, hashText, stripBlock } from "./cards";
import { plural } from "./features";

/** Notes with less text than this (outside the card block) are skipped, as in folder runs. */
export const MIN_NOTE_CHARS = 80;

/**
 * fresh: cards were made from the current text. changed: the text changed since then.
 * new: no cards yet. short: too little text to make cards from.
 */
export type NoteState = "fresh" | "changed" | "new" | "short";

export interface SyncEntry {
	mtime: number;
	size: number;
	state: NoteState;
}

/** Per-note record, keyed by note path. Stored in the plugin's data.json. */
export type SyncIndex = Record<string, SyncEntry>;

export interface NoteRef {
	path: string;
	stat: { mtime: number; size: number };
}

/** What a note's text says about its cards. */
export function classify(content: string): NoteState {
	const body = stripBlock(content);
	if (body.trim().length < MIN_NOTE_CHARS) return "short";
	const block = findBlock(content);
	if (!block) return "new";
	return block.hash === hashText(body) ? "fresh" : "changed";
}

export function needsRefresh(state: NoteState): boolean {
	return state === "changed" || state === "new";
}

export interface ScanResult {
	/** Paths of notes that changed since their cards were made or have no cards yet, in input order. */
	pending: string[];
	/** The updated record: one entry per note passed in, nothing else (removed notes drop out). */
	index: SyncIndex;
	/** How many notes were read. */
	reads: number;
	/** Whether `index` differs from the record passed in (so it needs saving). */
	dirty: boolean;
}

/**
 * Check `notes` against the record. A note is read (with `read`) only when it has no record or its
 * modified time or size changed. A note that cannot be read is left out of `pending` and not recorded.
 */
export async function scanNotes(notes: NoteRef[], index: SyncIndex, read: (path: string) => Promise<string>): Promise<ScanResult> {
	const next: SyncIndex = {};
	const pending: string[] = [];
	let reads = 0;
	let dirty = false;
	for (const n of notes) {
		const old = index[n.path];
		let entry: SyncEntry;
		if (old && old.mtime === n.stat.mtime && old.size === n.stat.size) {
			entry = old;
		} else {
			let text: string;
			try {
				reads++;
				text = await read(n.path);
			} catch {
				continue;
			}
			entry = { mtime: n.stat.mtime, size: n.stat.size, state: classify(text) };
			dirty = true;
		}
		next[n.path] = entry;
		if (needsRefresh(entry.state)) pending.push(n.path);
	}
	if (Object.keys(index).some((p) => !(p in next))) dirty = true;
	return { pending, index: next, reads, dirty };
}

/** Synced folder paths, cleaned: trimmed, no trailing slash, "/" for the vault root, no duplicates. */
export function cleanFolders(paths: string[]): string[] {
	const out: string[] = [];
	for (const raw of paths) {
		const t = raw.trim().replace(/\/+$/, "");
		const p = t === "" ? "/" : t;
		if (!out.includes(p)) out.push(p);
	}
	return out;
}

/** Status bar and notice text: "1 note has new content", "7 notes have new content". */
export function pendingText(n: number): string {
	return `${plural(n, "note")} ${n === 1 ? "has" : "have"} new content`;
}
