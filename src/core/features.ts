import type { CardType } from "./cards";
import { FREE_MAX_CARDS, PRO_MAX_CARDS } from "../config";

/** Single source of truth for the free/Pro split (also used by the README table test). */
export const PRO_FEATURES = {
	batchFolder: "Generate cards for a whole folder in one run",
	refreshChanged: "Refresh only the notes that changed since their cards were made, keeping Spaced Repetition review history",
	bulkExport: "Export a folder or the whole vault to Anki, with decks from folders",
	customInstructions: "Custom instructions for the model",
	moreCards: `Up to ${PRO_MAX_CARDS} cards per note (free: ${FREE_MAX_CARDS})`,
} as const;

export type ProFeature = keyof typeof PRO_FEATURES;

/** Card types to ask for. Cloze and reversed cards are free since 0.1.5; `isPro` is kept for call sites. */
export function allowedTypes(_isPro: boolean, wanted: { reversed: boolean; cloze: boolean }): CardType[] {
	const t: CardType[] = ["basic"];
	if (wanted.reversed) t.push("reversed");
	if (wanted.cloze) t.push("cloze");
	return t;
}

/** One free folder run per vault, on up to this many notes. */
export const FREE_FOLDER_RUN_NOTES = 5;

/** "1 card", "2 cards". */
export function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function cardCap(isPro: boolean, requested: number): number {
	const max = isPro ? PRO_MAX_CARDS : FREE_MAX_CARDS;
	return Math.max(1, Math.min(max, Math.floor(requested) || 1));
}
