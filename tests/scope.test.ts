import { describe, expect, it } from "vitest";
import { TFile, TFolder } from "obsidian";
import { markdownUnder } from "../src/core/scope";

function folder(path: string, kids: (TFile | TFolder)[]): TFolder {
	const f = new TFolder(path);
	f.children = kids;
	return f;
}

describe("markdownUnder (folder-scoped note listing)", () => {
	const bio = folder("School/Bio", [
		new TFile("School/Bio/Cells.md"),
		new TFile("School/Bio/diagram.png"),
		folder("School/Bio/Plants", [new TFile("School/Bio/Plants/Leaves.md")]),
	]);
	const exports = folder("Cardsmith exports", [new TFile("Cardsmith exports/old.md")]);
	const root = folder("", [bio, exports, new TFile("Inbox.md")]);

	it("lists only markdown notes inside the chosen folder, including subfolders", () => {
		expect(markdownUnder(bio).map((f) => f.path)).toEqual(["School/Bio/Cells.md", "School/Bio/Plants/Leaves.md"]);
	});

	it("does not touch siblings or parents of the chosen folder", () => {
		const paths = markdownUnder(bio).map((f) => f.path);
		expect(paths).not.toContain("Inbox.md");
		expect(paths).not.toContain("Cardsmith exports/old.md");
	});

	it("skips the Anki export folder when the vault root is chosen", () => {
		expect(markdownUnder(root, "Cardsmith exports").map((f) => f.path)).toEqual([
			"Inbox.md",
			"School/Bio/Cells.md",
			"School/Bio/Plants/Leaves.md",
		]);
	});
});
