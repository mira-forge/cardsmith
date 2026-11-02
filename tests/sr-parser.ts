/**
 * Port of the Spaced Repetition plugin's card parser (src/parser.ts, st3v3nmw/obsidian-spaced-repetition
 * at 3d5079f, 2026-08-03), used only by tests to check that Cardsmith's output parses the way SR parses it.
 * Copyright (c) 2021 - 2024 Stephen Mwangi. MIT License.
 * Changes: the clozecraft dependency is replaced by a check for SR's three default cloze patterns
 * (==x==, **x**, {{x}}); card types are strings.
 */
export type SrCardType = "SingleLineBasic" | "SingleLineReversed" | "MultiLineBasic" | "MultiLineReversed" | "Cloze";
export interface SrParsed { cardType: SrCardType; text: string; firstLineNum: number; lastLineNum: number }

const SR_METADATA_CALLOUT = "> [!sr|card-metadata]";
const isClozeNote = (l: string) => /==[^=]+==|\*\*[^*]+\*\*|\{\{[^}]+\}\}/.test(l);

function markerInsideCodeBlock(text: string, marker: string, idx: number): boolean {
	let before = 0, after = 0;
	for (let i = idx - 1; i >= 0; i--) if (text[i] === "`") before++;
	for (let i = idx + marker.length; i < text.length; i++) if (text[i] === "`") after++;
	return before % 2 === 1 && after % 2 === 1;
}
function hasInlineMarker(text: string, marker: string): boolean {
	if (!marker) return false;
	const i = text.indexOf(marker);
	return i !== -1 && !markerInsideCodeBlock(text, marker, i);
}

export function srParse(text: string, endMarker = ""): SrParsed[] {
	const inline: { separator: string; type: SrCardType }[] = [
		{ separator: "::", type: "SingleLineBasic" },
		{ separator: ":::", type: "SingleLineReversed" },
	].sort((a, b) => b.separator.length - a.separator.length) as { separator: string; type: SrCardType }[];
	const cards: SrParsed[] = [];
	let cardText = "";
	let cardType: SrCardType | null = null;
	let firstLineNo = 0;
	const lines = text.replaceAll("\r\n", "\n").split("\n");
	for (let i = 0; i < lines.length; i++) {
		const cur = lines[i]!, trimmed = cur.trim();
		if (cur.startsWith("<!--") && !cur.startsWith("<!--SR:")) {
			while (i + 1 < lines.length && !cur.includes("-->")) i++;
			i++;
			continue;
		}
		const empty = trimmed.length === 0;
		const hasEnd = endMarker && trimmed === endMarker;
		if ((empty && !endMarker) || (empty && cardType === null) || hasEnd) {
			if (cardType) {
				cards.push({ cardType, text: cardText.trimEnd(), firstLineNum: firstLineNo, lastLineNum: i - 1 });
				cardType = null;
			}
			cardText = "";
			firstLineNo = i + 1;
			continue;
		}
		if (cardText.length > 0) cardText += "\n";
		cardText += cur.trimEnd();
		for (const { separator, type } of inline) {
			if (hasInlineMarker(cur, separator)) { cardType = type; break; }
		}
		if (cardType === "SingleLineBasic" || cardType === "SingleLineReversed") {
			cardText = cur;
			firstLineNo = i;
			if (i + 1 < lines.length && lines[i + 1]!.startsWith("<!--SR:")) {
				cardText += "\n" + lines[i + 1];
				i++;
			} else if (i + 1 < lines.length && lines[i + 1]!.startsWith(SR_METADATA_CALLOUT)) {
				for (let j = i + 1; j < lines.length; j++) {
					cardText += "\n" + lines[j];
					i++;
					if (lines[j]!.includes("<!--SR:")) break;
				}
			}
			cards.push({ cardType, text: cardText, firstLineNum: firstLineNo, lastLineNum: i });
			cardType = null;
			cardText = "";
		} else if (trimmed === "?") {
			if (cardText.length > 1) cardType = "MultiLineBasic";
		} else if (trimmed === "??") {
			if (cardText.length > 1) cardType = "MultiLineReversed";
		} else if (cur.startsWith("```") || cur.startsWith("~~~")) {
			const close = cur.match(/`+|~+/)![0];
			while (i + 1 < lines.length && !lines[i + 1]!.startsWith(close)) { i++; cardText += "\n" + lines[i]; }
			cardText += "\n" + close;
			i++;
		} else if (cardType === null && isClozeNote(cur)) {
			cardType = "Cloze";
		}
	}
	if (cardType && cardText) cards.push({ cardType, text: cardText.trimEnd(), firstLineNum: firstLineNo, lastLineNum: lines.length - 1 });
	return cards;
}

/** Where SR writes a card's schedule: on the line after the card's last line (default setting). */
export function srSchedule(note: string, card: SrParsed, comment: string): string {
	const lines = note.split("\n");
	lines.splice(card.lastLineNum + 1, 0, comment);
	return lines.join("\n");
}
