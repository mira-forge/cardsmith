import { describe, expect, it } from "vitest";
import { buildBlock, findBlock, formatCard, mergeBlock, upsertBlock, type Card } from "../src/core/cards";
import { carryHistory } from "../src/core/history";
import { parseSrCards } from "../src/core/anki";

const SR1 = "<!--SR:!2026-11-02,7,250-->";
const SR2 = "<!--SR:!2026-11-20,21,270-->";
const SR3 = "<!--SR:!2026-11-05,3,230!2026-11-09,6,250-->"; // two siblings (reversed / multi-cloze)

const basic = (front: string, back: string): Card => ({ type: "basic", front, back });

/** A note whose Cardsmith block has been reviewed: SR wrote a comment after some cards. */
function reviewedNote(blockBody: string): string {
	return `# Cells\n\nCells are small.\n\n%% cardsmith:start hash=aaaaaaaa %%\n#flashcards\n\n${blockBody}\n%% cardsmith:end %%\n`;
}

describe("review history survives a rewrite (fix for 0.1.4 data loss)", () => {
	it("an unchanged card keeps its comment right after it", () => {
		const note = reviewedNote(`What does the mitochondrion produce?::ATP\n${SR1}`);
		const out = upsertBlock(note, buildBlock([basic("What does the mitochondrion produce?", "ATP")], "#flashcards", "bbbbbbbb"));
		expect(out).toContain(`What does the mitochondrion produce?::ATP\n${SR1}\n%% cardsmith:end %%`);
		expect(findBlock(out)?.hash).toBe("bbbbbbbb");
		expect(out.startsWith("# Cells\n\nCells are small.\n\n")).toBe(true);
	});

	it("matching ignores case, spacing and the zero-width escapes Cardsmith adds", () => {
		const note = reviewedNote(`what does the  mitochondrion produce? :: atp\n${SR1}`);
		const out = upsertBlock(note, buildBlock([basic("What does the mitochondrion produce?", "ATP")], "#flashcards", "b"));
		expect(out).toContain(`::ATP\n${SR1}`);
		const esc = reviewedNote(`${formatCard(basic("a::b", "c"))}\n${SR2}`);
		expect(upsertBlock(esc, buildBlock([basic("a::b", "c")], "#flashcards", "b"))).toContain(`${formatCard(basic("a::b", "c"))}\n${SR2}`);
	});

	it("cards that stay keep theirs when other cards change, are added or move", () => {
		const note = reviewedNote(["Q1::A1", SR1, "", "Q2::A2", SR2, "", "Q3::A3"].join("\n"));
		const block = buildBlock([basic("New question?", "New"), basic("Q2", "A2"), basic("Q3", "A3 edited"), basic("Q1", "A1")], "#flashcards", "c");
		const r = mergeBlock(note, block);
		expect(r.block).toContain(`Q2::A2\n${SR2}`);
		expect(r.block).toContain(`Q1::A1\n${SR1}`);
		expect(r.block).toContain("New question?::New\n\n");
		expect(r.block).toContain("Q3::A3 edited\n\nQ1::A1"); // Q3 had no history
		expect(r).toMatchObject({ kept: 2, dropped: 0 });
	});

	it("an edited answer keeps the history of the same question", () => {
		const note = reviewedNote(`Where is DNA stored?::Nucleus\n${SR1}`);
		const r = mergeBlock(note, buildBlock([basic("Where is DNA stored?", "In the nucleus")], "#flashcards", "d"));
		expect(r.block).toContain(`Where is DNA stored?::In the nucleus\n${SR1}`);
		expect(r.kept).toBe(1);
	});

	it("an exact question+answer match wins over a question-only match", () => {
		const note = reviewedNote(["Q::old", SR1, "", "Q::new", SR2].join("\n"));
		const r = mergeBlock(note, buildBlock([basic("Q", "new")], "#flashcards", "e"));
		expect(r.block).toContain(`Q::new\n${SR2}`);
		expect(r.block).not.toContain(SR1);
		expect(r).toMatchObject({ kept: 1, dropped: 1 });
	});

	it("a removed card's comment is dropped and counted", () => {
		const note = reviewedNote(["Q1::A1", SR1, "", "Q2::A2", SR2].join("\n"));
		const r = mergeBlock(note, buildBlock([basic("Q2", "A2")], "#flashcards", "f"));
		expect(r.block).not.toContain(SR1);
		expect(r.block).toContain(`Q2::A2\n${SR2}`);
		expect(r).toMatchObject({ kept: 1, dropped: 1 });
		expect(r.block.match(/<!--SR:/g)?.length).toBe(1);
	});

	it("multi-line cards keep their comment after the last line", () => {
		const note = reviewedNote(["Name the stages of mitosis", "?", "Prophase, metaphase,", "anaphase, telophase", SR3].join("\n"));
		const card = basic("Name the stages of mitosis", "Prophase, metaphase,\nanaphase, telophase");
		const out = upsertBlock(note, buildBlock([card], "#flashcards", "g"));
		expect(out).toContain(`anaphase, telophase\n${SR3}\n%% cardsmith:end %%`);
		// and SR still reads it as one card with the comment outside the answer
		const cards = parseSrCards(out);
		expect(cards).toHaveLength(1);
	});

	it("cloze and reversed cards keep theirs", () => {
		const note = reviewedNote(["The ==nucleus== holds DNA.", SR3, "", "Mitochondrion:::Organelle that makes ATP", SR2].join("\n"));
		const cards: Card[] = [
			{ type: "reversed", front: "Mitochondrion", back: "Organelle that makes ATP" },
			{ type: "cloze", front: "The ==nucleus== holds DNA.", back: "" },
		];
		const r = mergeBlock(note, buildBlock(cards, "#flashcards", "h"));
		expect(r.block).toContain(`Mitochondrion:::Organelle that makes ATP\n${SR2}`);
		expect(r.block).toContain(`The ==nucleus== holds DNA.\n${SR3}`);
		expect(r.kept).toBe(2);
	});

	it("a multi-line reversed card keeps its history", () => {
		const note = reviewedNote(["Osmosis", "??", "Water moving across a membrane", SR2].join("\n"));
		const card: Card = { type: "reversed", front: "Osmosis", back: "Water moving\nacross a membrane" };
		const r = mergeBlock(note, buildBlock([card], "#flashcards", "i"));
		expect(r.block).toContain(`across a membrane\n${SR2}`);
	});

	it("keeps the same-line comment style and block ids", () => {
		const note = reviewedNote([`Q1::A1 ${SR1}`, "", `Q2::A2 ${SR2} ^card-2`, "", "Q3::A3 ^card-3", SR3].join("\n"));
		const r = mergeBlock(note, buildBlock([basic("Q3", "A3"), basic("Q2", "A2"), basic("Q1", "A1")], "#flashcards", "j"));
		expect(r.block).toContain(`Q1::A1 ${SR1}`);
		expect(r.block).toContain(`Q2::A2 ${SR2} ^card-2`);
		expect(r.block).toContain(`Q3::A3 ^card-3\n${SR3}`);
		expect(r.kept).toBe(3);
	});

	it("keeps comments inside SR's metadata callout", () => {
		const note = reviewedNote(["Q1::A1", "> [!sr|card-metadata]", `> ${SR1}`].join("\n"));
		const r = mergeBlock(note, buildBlock([basic("Q1", "A1")], "#flashcards", "k"));
		expect(r.block).toContain(`Q1::A1\n> [!sr|card-metadata]\n> ${SR1}\n%% cardsmith:end %%`);
	});

	it("is a no-op for notes without a block or without history, and leaves text outside the block alone", () => {
		const block = buildBlock([basic("Q", "A")], "#flashcards", "l");
		expect(carryHistory(null, block)).toEqual({ block, kept: 0, dropped: 0, preserved: 0 });
		const plain = reviewedNote("Q::A");
		expect(mergeBlock(plain, block).block).toBe(block);
		const outside = `Intro ${SR1}\n\n` + reviewedNote(`Q::A\n${SR2}`);
		const out = upsertBlock(outside, block);
		expect(out.startsWith(`Intro ${SR1}\n\n# Cells`)).toBe(true);
	});

	it("re-running twice does not duplicate comments", () => {
		const note = reviewedNote(`Q::A\n${SR1}`);
		const block = buildBlock([basic("Q", "A")], "#flashcards", "m");
		const once = upsertBlock(note, block);
		const twice = upsertBlock(once, block);
		expect(twice).toBe(once);
		expect(twice.match(/<!--SR:/g)?.length).toBe(1);
	});
});

describe("multi-line cards are safe for Spaced Repetition", () => {
	it("collapses blank lines inside a card (SR ends a card at an empty line)", () => {
		const out = formatCard(basic("Explain osmosis", "Water moves across a membrane.\n\nIt goes toward the higher solute concentration."));
		expect(out).toBe("Explain osmosis\n?\nWater moves across a membrane.\nIt goes toward the higher solute concentration.");
		expect(out).not.toMatch(/\n\s*\n/);
		expect(parseSrCards(out)).toEqual([{ type: "basic", front: "Explain osmosis", back: "Water moves across a membrane.\nIt goes toward the higher solute concentration." }]);
	});
	it("multi-line cloze becomes one line", () => {
		expect(formatCard({ type: "cloze", front: "The ==nucleus==\n\n holds DNA.", back: "" })).toBe("The ==nucleus== holds DNA.");
	});
});

describe("reviewed cards are never removed unseen (keepUnmatched)", () => {
	it("keeps a reviewed card that is not in the new set, with its history, at the end of the block", () => {
		const note = reviewedNote(`Q1::A1\n${SR1}\n\nGone?::Yes\n${SR2}\n\nNo history::x`);
		const r = mergeBlock(note, buildBlock([basic("Q1", "A1"), basic("New", "Card")], "#flashcards", "k"), true);
		expect(r).toMatchObject({ kept: 1, dropped: 0, preserved: 1 });
		expect(r.block).toContain(`Q1::A1\n${SR1}`);
		expect(r.block).toContain(`New::Card\n\nGone?::Yes\n${SR2}\n%% cardsmith:end %%`);
		expect(r.block).not.toContain("No history"); // unreviewed cards are still replaced
		expect(parseSrCards(r.block).map((c) => c.front)).toEqual(["Q1", "New", "Gone?"]);
	});

	it("keeps multi-line, same-line and callout history verbatim, and is stable on re-run", () => {
		const body = [`Stages\n?\nPro, meta,\nana, telo\n${SR3}`, `Same::line ${SR1}`, `Call::out\n> [!sr|card-metadata] \n>  ${SR2}`].join("\n\n");
		const note = reviewedNote(body);
		const block = buildBlock([basic("Other", "Card")], "#flashcards", "k");
		const once = upsertBlock(note, block, true);
		expect(once).toContain(`Stages\n?\nPro, meta,\nana, telo\n${SR3}`);
		expect(once).toContain(`Same::line ${SR1}`);
		expect(once).toContain(`Call::out\n> [!sr|card-metadata] \n>  ${SR2}`);
		const twice = upsertBlock(once, block, true);
		expect(twice).toBe(once);
		expect(twice.match(/<!--SR:/g)?.length).toBe(3);
	});

	it("without keepUnmatched the unmatched card is removed and counted", () => {
		const note = reviewedNote(`Gone?::Yes\n${SR2}`);
		const r = mergeBlock(note, buildBlock([basic("New", "Card")], "#flashcards", "k"));
		expect(r).toMatchObject({ kept: 0, dropped: 1, preserved: 0 });
		expect(r.block).not.toContain("Gone?");
	});
});

describe("findBlock with a deleted end marker", () => {
	it("an orphan start marker never makes Cardsmith delete the user's text (E8)", () => {
		const n = ["# T", "", "Intro.", "", "%% cardsmith:start hash=aaaaaaaa %%", "#flashcards", "", "Q::A", SR1, "", "## My later notes", "Important paragraph the user wrote.", ""].join("\n");
		const once = upsertBlock(n, buildBlock([basic("Q", "A")], "#flashcards", "b"));
		const twice = upsertBlock(once, buildBlock([basic("Q", "A")], "#flashcards", "c"));
		expect(once).toContain("Important paragraph the user wrote.");
		expect(twice).toContain("Important paragraph the user wrote.");
		expect(twice).toContain("## My later notes");
		expect(findBlock(twice)?.hash).toBe("c");
	});

	it("a block id answer like 'x ^2' is not doubled on re-run (E9)", () => {
		const n = reviewedNote(`What is x times x?::x ^2\n${SR1}`);
		const block = buildBlock([basic("What is x times x?", "x ^2")], "#flashcards", "b");
		const out = upsertBlock(upsertBlock(n, block), block);
		expect(out).toContain(`What is x times x?::x ^2\n${SR1}`);
		expect(out).not.toContain("^2 ^2");
	});
});
