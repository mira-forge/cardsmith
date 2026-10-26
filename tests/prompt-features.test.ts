import { describe, expect, it } from "vitest";
import { buildMessages, MAX_INPUT_CHARS } from "../src/core/prompt";
import { allowedTypes, cardCap, plural, PRO_FEATURES } from "../src/core/features";
import { FREE_MAX_CARDS, PRO_MAX_CARDS } from "../src/config";

describe("prompt", () => {
	it("asks for JSON, respects types and truncates long notes", () => {
		const { system, user } = buildMessages("T", "x".repeat(MAX_INPUT_CHARS + 500), { maxCards: 5, types: ["basic"], language: "", extraInstructions: "" });
		expect(system).toMatch(/JSON/);
		expect(user.length).toBeLessThan(MAX_INPUT_CHARS + 1000);
		expect(system + user).not.toMatch(/cloze/i);
	});
	it("reports when a long note was cut", () => {
		const opts = { maxCards: 5, types: ["basic" as const], language: "", extraInstructions: "" };
		expect(buildMessages("T", "x".repeat(MAX_INPUT_CHARS + 1), opts).truncated).toBe(true);
		expect(buildMessages("T", "x".repeat(MAX_INPUT_CHARS), opts).truncated).toBe(false);
	});
});

describe("free / Pro split", () => {
	it("free gets cloze and reversed (since 0.1.5) but keeps the free cap", () => {
		expect(allowedTypes(false, { reversed: true, cloze: true })).toEqual(["basic", "reversed", "cloze"]);
		expect(allowedTypes(false, { reversed: false, cloze: false })).toEqual(["basic"]);
		expect(cardCap(false, 999)).toBe(FREE_MAX_CARDS);
		expect(Object.values(PRO_FEATURES).join(" ")).not.toMatch(/cloze|reversed/i);
	});
	it("plural", () => {
		expect(plural(1, "card")).toBe("1 card");
		expect(plural(0, "card")).toBe("0 cards");
		expect(plural(2, "note")).toBe("2 notes");
	});
	it("Pro unlocks types and a higher cap", () => {
		expect(allowedTypes(true, { reversed: true, cloze: true })).toEqual(["basic", "reversed", "cloze"]);
		expect(cardCap(true, 999)).toBe(PRO_MAX_CARDS);
		expect(cardCap(true, 0)).toBe(1);
	});
});
