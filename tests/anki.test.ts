import { describe, expect, it } from "vitest";
import { deckFromPath, parseSrCards, toAnkiCloze, toAnkiTsv } from "../src/core/anki";

const note = `---
q: not::a card
---
#flashcards
Capital of France::Paris
Hola:::Hello

What are the phases?
?
Prophase
Metaphase

The ==mitochondria== is the ==powerhouse==.

\`\`\`
code::not a card
\`\`\`
%% comment::not a card %%
`;

describe("parseSrCards", () => {
	it("reads single-line, reversed, multi-line and cloze cards and skips code/frontmatter/comments", () => {
		const c = parseSrCards(note);
		expect(c).toEqual([
			{ type: "basic", front: "Capital of France", back: "Paris" },
			{ type: "reversed", front: "Hola", back: "Hello" },
			{ type: "basic", front: "What are the phases?", back: "Prophase\nMetaphase" },
			{ type: "cloze", front: "The ==mitochondria== is the ==powerhouse==.", back: "" },
		]);
	});
});

describe("Anki export", () => {
	it("converts cloze and decks", () => {
		expect(toAnkiCloze("==a== and ==b==")).toBe("{{c1::a}} and {{c2::b}}");
		expect(deckFromPath("Bio/Cells/Mitosis.md")).toBe("Bio::Cells");
		expect(deckFromPath("Root.md")).toBe("Cardsmith");
	});
	it("writes a TSV with Anki file headers", () => {
		const tsv = toAnkiTsv([
			{ type: "basic", front: 'Say "hi"', back: "a\tb", deck: "D", tags: ["#flashcards"] },
			{ type: "cloze", front: "==x== y", back: "", deck: "D", tags: [] },
		]);
		const lines = tsv.replace(/\n$/, "").split("\n");
		expect(lines.slice(0, 5)).toEqual(["#separator:tab", "#html:true", "#notetype column:1", "#deck column:2", "#tags column:5"]);
		expect(lines[5]!.split("\t")).toHaveLength(5);
		expect(lines[5]).toMatch(/^Basic\tD\t"Say ""hi"""/);
		expect(lines[6]).toBe("Cloze\tD\t{{c1::x}} y\t\t");
	});
});
