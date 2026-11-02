import { describe, expect, it } from "vitest";
import { buildBlock, findBlock, hashText, stripBlock, upsertBlock, type Card } from "../src/core/cards";
import { srParse, srSchedule } from "./sr-parser";

const cards: Card[] = [
	{ type: "basic", front: "What does the mitochondrion make?", back: "ATP" },
	{ type: "reversed", front: "Mitosis", back: "Cell division into two identical cells" },
	{ type: "basic", front: "Name the phases of mitosis", back: "prophase, metaphase\nanaphase, telophase" },
	{ type: "reversed", front: "Cytokinesis\n(term)", back: "Splitting of the cytoplasm" },
	{ type: "cloze", front: "The ==nucleus== holds the DNA.", back: "" },
];
const body = "# Cells\n\nCells are the basic unit of life. Mitochondria make ATP and the nucleus holds DNA.";
const insert = (note: string, cs: Card[]) => upsertBlock(note, buildBlock(cs, "#flashcards", hashText(stripBlock(note))), true);
const inBlock = (note: string, s: string) => {
	const b = findBlock(note)!;
	return note.slice(b.start, b.end).includes(s);
};

describe("output parses the way the Spaced Repetition plugin parses it", () => {
	it("every card type is recognised, and no card swallows the end marker", () => {
		const note = insert(body, cards);
		const parsed = srParse(note);
		expect(parsed.map((p) => p.cardType)).toEqual(["SingleLineBasic", "SingleLineReversed", "MultiLineBasic", "MultiLineReversed", "Cloze"]);
		for (const p of parsed) expect(p.text).not.toContain("cardsmith");
		expect(parsed[2]!.text).toBe("Name the phases of mitosis\n?\nprophase, metaphase\nanaphase, telophase");
		expect(parsed[3]!.text).toBe("Cytokinesis\n(term)\n??\nSplitting of the cytoplasm");
	});

	it("subdeck tags are written as given", () => {
		expect(buildBlock(cards.slice(0, 1), "flashcards/biology/cells", "0")).toContain("\n#flashcards/biology/cells\n");
	});

	it("schedules SR writes land inside the block and survive a regenerate (round trip)", () => {
		let note = insert(body, cards);
		// SR reviews every card: insert comments bottom-up, as it would, at the line after each card
		const parsed = srParse(note);
		const sched = parsed.map((_, i) => `<!--SR:!2026-11-1${i},${i + 3},250-->`);
		for (let i = parsed.length - 1; i >= 0; i--) note = srSchedule(note, parsed[i]!, sched[i]!);
		for (const s of sched) expect(inBlock(note, s)).toBe(true);
		// SR still parses five cards, each now carrying its schedule
		const again = srParse(note);
		expect(again).toHaveLength(5);
		// regenerate with the same cards in a different order: every schedule comes back after its card
		const out = insert(note, [...cards].reverse());
		for (const s of sched) expect(inBlock(out, s)).toBe(true);
		const reparsed = srParse(out);
		expect(reparsed).toHaveLength(5);
		for (const p of reparsed) expect(p.text).toMatch(/<!--SR:!2026-11-1\d,\d,250-->$/);
		expect(reparsed.find((p) => p.cardType === "Cloze")!.text).toBe(`The ==nucleus== holds the DNA.\n${sched[4]}`);
	});

	it("keeps a schedule an older version let SR write after the end marker", () => {
		// pre-0.1.9 block: no blank line before the end marker, SR put the cloze schedule after it
		const legacy = `${body}\n\n%% cardsmith:start hash=00000000 %%\n#flashcards\n\nQ::A\n\nThe ==nucleus== holds the DNA.\n%% cardsmith:end %%\n<!--SR:!2026-11-20,9,270-->\n`;
		expect(stripBlock(legacy)).toBe(body);
		const out = insert(legacy, [cards[4]!, { type: "basic", front: "Q", back: "A" }]);
		expect(out).toContain("The ==nucleus== holds the DNA.\n<!--SR:!2026-11-20,9,270-->\n");
		expect(out.match(/<!--SR:/g)).toHaveLength(1);
		expect(out.trimEnd().endsWith("%% cardsmith:end %%")).toBe(true);
	});
});
