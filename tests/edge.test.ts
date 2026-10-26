import { describe, expect, it } from "vitest";
import { buildBlock, findBlock, formatCard, mergeBlock, upsertBlock, type Card } from "../src/core/cards";
import { parseSrCards } from "../src/core/anki";
const SR1 = "<!--SR:!2026-11-02,7,250-->";
const SR2 = "<!--SR:!2026-11-20,21,270-->";
const FS = "<!--SR:!fsrs,2026-11-02T00:00:00.000Z,3,5,1,0,2,0,2026-10-26T00:00:00.000Z-->";
const b = (front: string, back: string): Card => ({ type: "basic", front, back });
const note = (body: string, eol = "\n") => [`# T`, ``, `Text.`, ``, `%% cardsmith:start hash=aaaaaaaa %%`, `#flashcards`, ``, ...body.split("\n"), `%% cardsmith:end %%`, ``].join(eol);
const show = (s: string) => console.log(JSON.stringify(s));

describe("edge", () => {
	it("E1 duplicate fronts, both reviewed, both regenerated identically", () => {
		const n = note(["Q::A1", SR1, "", "Q::A2", SR2].join("\n"));
		const r = mergeBlock(n, buildBlock([b("Q", "A1"), b("Q", "A2")], "#flashcards", "b"));
		show(r.block); expect(r.block).toContain(`Q::A1\n${SR1}`); expect(r.block).toContain(`Q::A2\n${SR2}`);
	});
	it("E2 user edited question between runs -> history dropped (reported)", () => {
		const n = note(["What is ATP made by?::Mitochondria", SR1].join("\n"));
		const r = mergeBlock(n, buildBlock([b("What produces ATP?", "Mitochondria")], "#flashcards", "b"));
		show(r.block); console.log(r.kept, r.dropped);
	});
	it("E3 multi-line same-line comment", () => {
		const n = note(["Stages", "?", "Pro, meta,", `ana, telo ${SR1}`].join("\n"));
		const r = mergeBlock(n, buildBlock([b("Stages", "Pro, meta,\nana, telo")], "#flashcards", "b"));
		show(r.block); expect(r.block).toContain(`ana, telo ${SR1}`);
	});
	it("E4 SR's real callout output (trailing space, double space, block id on callout line)", () => {
		const n = note(["Q::A", "> [!sr|card-metadata] ", `>  ${SR1} ^abc`].join("\n"));
		const r = mergeBlock(n, buildBlock([b("Q", "A")], "#flashcards", "b"));
		show(r.block); expect(r.block).toContain(`Q::A\n> [!sr|card-metadata] \n>  ${SR1} ^abc`);
	});
	it("E5 next-line + block id (SR format `Q::A ^id\\n<!--SR-->`)", () => {
		const n = note(["Q::A ^id1", SR1].join("\n"));
		const r = mergeBlock(n, buildBlock([b("Q", "A")], "#flashcards", "b"));
		show(r.block); expect(r.block).toContain(`Q::A ^id1\n${SR1}`);
	});
	it("E6 CRLF note", () => {
		const n = note(["Q1::A1", SR1, "", "Q2::A2", SR2].join("\n"), "\r\n");
		const out = upsertBlock(n, buildBlock([b("Q1", "A1"), b("Q2", "A2")], "#flashcards", "b"));
		show(out); expect(out).toContain(`Q1::A1\n${SR1}`); expect(out).toContain(`Q2::A2\n${SR2}`);
		expect(out.match(/<!--SR/g)?.length).toBe(2);
	});
	it("E7 FSRS comment", () => {
		const n = note([`Q::A ${FS}`, "", "R::B", FS].join("\n"));
		const r = mergeBlock(n, buildBlock([b("Q", "A"), b("R", "B")], "#flashcards", "b"));
		show(r.block); expect(r.kept).toBe(2);
	});
	it("E8 user deleted end marker: orphan start, then two runs", () => {
		let n = ["# T", "", "Intro.", "", "%% cardsmith:start hash=aaaaaaaa %%", "#flashcards", "", "Q::A", SR1, "", "## My later notes", "Important paragraph the user wrote.", ""].join("\n");
		n = upsertBlock(n, buildBlock([b("Q", "A")], "#flashcards", "b"));
		show(n);
		const n2 = upsertBlock(n, buildBlock([b("Q", "A")], "#flashcards", "c"));
		show(n2);
		console.log("E8 user text survives run 2:", n2.includes("Important paragraph"));
	});
	it("E9 answer ending in ' ^2' (looks like a block id)", () => {
		const n = note(["What is x times x?::x ^2", SR1].join("\n"));
		const r = mergeBlock(n, buildBlock([b("What is x times x?", "x ^2")], "#flashcards", "b"));
		show(r.block);
		const n0 = note("What is x times x?::x ^2"); // no history at all
		const r0 = mergeBlock(n0, buildBlock([b("What is x times x?", "x ^2")], "#flashcards", "b"));
		show(r0.block);
		console.log("E9 corrupt:", r.block.includes("^2 ^2"), r0.block.includes("^2 ^2"));
	});
	it("E10 multi-line card containing '::' in answer — how Cardsmith formats vs SR", () => {
		const f = formatCard(b("Explain syntax", "Write a::b\nfor basic cards"));
		show(f); show(JSON.stringify(parseSrCards(f)));
	});
	it("E11 selection re-run replaces the whole block", () => {
		const n = note(["Part1 Q::A", SR1, "", "Part1 R::B", SR2].join("\n"));
		const r = mergeBlock(n, buildBlock([b("Part2 Q", "C")], "#flashcards", "b"));
		console.log("E11", r.kept, r.dropped, r.block.includes("Part1"));
	});
	it("E12 SR comment line indented / separated by blank line from card", () => {
		const n = note(["Q::A", "", SR1].join("\n"));
		const r = mergeBlock(n, buildBlock([b("Q", "A")], "#flashcards", "b"));
		console.log("E12", r.kept, r.dropped); show(r.block);
	});
	it("E13 card text starts on the tag line (Q right after #flashcards, no blank)", () => {
		const n = ["%% cardsmith:start hash=a %%", "#flashcards", "Q::A", SR1, "%% cardsmith:end %%"].join("\n");
		const r = mergeBlock(n, buildBlock([b("Q", "A")], "#flashcards", "b"));
		console.log("E13", r.kept); 
	});
	it("E14 two cloze lines adjacent w/o blank (user-made), multi cloze", () => {
		const n = note(["The ==a== is b.", SR1, "", "The ==c== and ==d==.", "<!--SR:!2026-11-02,7,250!2026-11-03,7,250-->"].join("\n"));
		const r = mergeBlock(n, buildBlock([{ type: "cloze", front: "The ==a== is b.", back: "" }, { type: "cloze", front: "The ==c== and ==d==.", back: "" }], "#flashcards", "b"));
		console.log("E14", r.kept); show(r.block);
	});
	it("E15 block id before same-line comment (manual order)", () => {
		const n = note([`Q::A ^x ${SR1}`].join("\n"));
		const r = mergeBlock(n, buildBlock([b("Q", "A")], "#flashcards", "b"));
		show(r.block); console.log("E15", r.kept);
	});
	it("E16 idempotent with callout + same-line + crlf", () => {
		const n = note(["Q::A", "> [!sr|card-metadata] ", `>  ${SR1}`, "", `R::B ${SR2}`].join("\n"), "\r\n");
		const blk = buildBlock([b("Q", "A"), b("R", "B")], "#flashcards", "b");
		const once = upsertBlock(n, blk); const twice = upsertBlock(once, blk);
		expect(twice).toBe(once);
	});
});
