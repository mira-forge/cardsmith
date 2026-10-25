import { describe, expect, it } from "vitest";
import { buildMessages, MAX_INPUT_CHARS } from "../src/core/prompt";
import { allowedTypes, cardCap } from "../src/core/features";
import { FREE_MAX_CARDS, PRO_MAX_CARDS } from "../src/config";

describe("prompt", () => {
	it("asks for JSON, respects types and truncates long notes", () => {
		const { system, user } = buildMessages("T", "x".repeat(MAX_INPUT_CHARS + 500), { maxCards: 5, types: ["basic"], language: "", extraInstructions: "" });
		expect(system).toMatch(/JSON/);
		expect(user.length).toBeLessThan(MAX_INPUT_CHARS + 1000);
		expect(system + user).not.toMatch(/cloze/i);
	});
});

describe("free / Pro split", () => {
	it("free gets basic only and the free cap", () => {
		expect(allowedTypes(false, { reversed: true, cloze: true })).toEqual(["basic"]);
		expect(cardCap(false, 999)).toBe(FREE_MAX_CARDS);
	});
	it("Pro unlocks types and a higher cap", () => {
		expect(allowedTypes(true, { reversed: true, cloze: true })).toEqual(["basic", "reversed", "cloze"]);
		expect(cardCap(true, 999)).toBe(PRO_MAX_CARDS);
		expect(cardCap(true, 0)).toBe(1);
	});
});
