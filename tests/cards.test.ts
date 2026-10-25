import { describe, expect, it } from "vitest";
import { buildBlock, extractJson, findBlock, formatCard, hashText, parseCards, stripBlock, upsertBlock } from "../src/core/cards";

describe("extractJson", () => {
	it("reads fenced and chatty output", () => {
		expect(extractJson('Sure!\n```json\n{"cards":[{"type":"basic","front":"a","back":"b"}]}\n```')).toEqual({ cards: [{ type: "basic", front: "a", back: "b" }] });
		expect(extractJson('Here: [{"front":"x","back":"y"}] done')).toEqual([{ front: "x", back: "y" }]);
		expect(() => extractJson("no json")).toThrow(/did not return JSON/);
	});
});

describe("parseCards", () => {
	const raw = JSON.stringify({
		cards: [
			{ type: "basic", front: "What is ATP?", back: "Energy currency" },
			{ type: "basic", front: "What is ATP?", back: "dup" },
			{ type: "reversed", front: "Mitochondria", back: "Powerhouse" },
			{ type: "cloze", front: "The ==nucleus== holds DNA" },
			{ type: "cloze", front: "No highlight here" },
			{ type: "basic", front: "", back: "empty" },
		],
	});
	it("validates, dedupes and downgrades types not allowed on free", () => {
		const c = parseCards(raw, ["basic"]);
		expect(c.map((x) => x.type)).toEqual(["basic", "basic"]);
		expect(c[1]).toMatchObject({ front: "Mitochondria", back: "Powerhouse" });
	});
	it("keeps cloze and reversed when allowed (Pro)", () => {
		const c = parseCards(raw, ["basic", "reversed", "cloze"]);
		expect(c.map((x) => x.type)).toEqual(["basic", "reversed", "cloze"]);
	});
	it("reports garbage clearly", () => {
		expect(() => parseCards("lol", ["basic"])).toThrow(/JSON/);
		expect(parseCards('{"cards":"nope"}', ["basic"])).toEqual([]);
	});
});

describe("formatting and blocks", () => {
	it("uses Spaced Repetition syntax", () => {
		expect(formatCard({ type: "basic", front: "Q", back: "A" })).toBe("Q::A");
		expect(formatCard({ type: "reversed", front: "Q", back: "A" })).toBe("Q:::A");
		expect(formatCard({ type: "basic", front: "Q", back: "line1\nline2" })).toBe("Q\n?\nline1\nline2");
		expect(formatCard({ type: "basic", front: "a::b", back: "c" })).not.toMatch(/a::b::/);
	});
	it("inserts, finds and replaces a managed block without touching the note", () => {
		const note = "# Cells\n\nCells are small.";
		const h = hashText(note);
		const b1 = buildBlock([{ type: "basic", front: "Q", back: "A" }], "flashcards", h);
		const once = upsertBlock(note, b1);
		expect(once.startsWith(note)).toBe(true);
		expect(once).toContain("#flashcards");
		expect(findBlock(once)?.hash).toBe(h);
		expect(stripBlock(once)).toBe(note);
		const twice = upsertBlock(once, buildBlock([{ type: "basic", front: "Q2", back: "A2" }], "#flashcards", h));
		expect(twice.match(/cardsmith:start/g)?.length).toBe(1);
		expect(twice).toContain("Q2::A2");
	});
	it("hash ignores whitespace changes only", () => {
		expect(hashText("a  b\n")).toBe(hashText("a b"));
		expect(hashText("a b")).not.toBe(hashText("a c"));
	});
});
