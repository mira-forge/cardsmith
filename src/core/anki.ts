/**
 * Offline export: read Spaced Repetition plugin cards from Markdown and write an
 * Anki-importable tab-separated file (Anki 2.1.55+ text import with file headers).
 * Works on any SR-format card, not only cards made by Cardsmith. No network use.
 */
import type { Card } from "./cards";

export interface ExportCard extends Card {
	deck: string;
	tags: string[];
}

const FENCE = /^(```|~~~)/;

/** Parse SR-format cards from a note. Skips code blocks, frontmatter and Obsidian comments. */
export function parseSrCards(note: string): Card[] {
	const lines = note.replace(/\r\n?/g, "\n").split("\n");
	const cards: Card[] = [];
	let i = 0;
	let inFence = false;
	if (lines[0] === "---") {
		const close = lines.indexOf("---", 1);
		if (close > 0) i = close + 1;
	}
	const para: string[] = [];
	const flushPara = () => {
		// multi-line cards: a paragraph containing a line that is exactly ? or ??
		if (para.length >= 3) {
			const sepIdx = para.findIndex((l) => l.trim() === "?" || l.trim() === "??");
			if (sepIdx > 0 && sepIdx < para.length - 1) {
				const sep = para[sepIdx]?.trim();
				cards.push({
					type: sep === "??" ? "reversed" : "basic",
					front: para.slice(0, sepIdx).join("\n").trim(),
					back: para.slice(sepIdx + 1).join("\n").trim(),
				});
			}
		}
		para.length = 0;
	};
	for (; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (FENCE.test(line.trim())) {
			inFence = !inFence;
			flushPara();
			continue;
		}
		if (inFence) continue;
		const t = line.trim();
		if (t.startsWith("%%")) {
			flushPara();
			continue;
		}
		if (t === "") {
			flushPara();
			continue;
		}
		const unz = line.replace(/\u200b/g, "");
		const rev = unz.indexOf(":::");
		const basic = unz.indexOf("::");
		if (rev > 0) {
			cards.push({ type: "reversed", front: unz.slice(0, rev).trim(), back: unz.slice(rev + 3).trim() });
			continue;
		}
		if (basic > 0) {
			cards.push({ type: "basic", front: unz.slice(0, basic).trim(), back: unz.slice(basic + 2).trim() });
			continue;
		}
		if (/==[^=]+==/.test(t) && !t.startsWith("#")) {
			cards.push({ type: "cloze", front: t, back: "" });
			continue;
		}
		para.push(line);
	}
	flushPara();
	return cards.filter((c) => c.front && (c.type === "cloze" || c.back));
}

function field(s: string): string {
	// HTML mode off in the header, so only tabs and newlines need handling.
	const v = s.replace(/\t/g, " ").replace(/\n/g, "<br>");
	return v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toAnkiCloze(text: string): string {
	let n = 0;
	return text.replace(/==([^=]+)==/g, (_m, inner: string) => `{{c${++n}::${inner}}}`);
}

/** Deck name from a vault path: `Biology/Cells/Mitosis.md` -> `Biology::Cells`. */
export function deckFromPath(path: string, root = "Cardsmith"): string {
	const parts = path.split("/").slice(0, -1).filter(Boolean);
	return parts.length ? parts.join("::") : root;
}

export function toAnkiTsv(cards: ExportCard[]): string {
	const header = [
		"#separator:tab",
		"#html:true",
		"#notetype column:1",
		"#deck column:2",
		"#tags column:5",
	];
	const rows = cards.map((c) => {
		const tags = c.tags.map((t) => t.replace(/^#/, "").replace(/\s+/g, "_")).join(" ");
		if (c.type === "cloze") {
			return ["Cloze", field(c.deck), field(toAnkiCloze(c.front)), "", tags].join("\t");
		}
		const nt = c.type === "reversed" ? "Basic (and reversed card)" : "Basic";
		return [nt, field(c.deck), field(c.front), field(c.back), tags].join("\t");
	});
	return header.join("\n") + "\n" + rows.join("\n") + "\n";
}
