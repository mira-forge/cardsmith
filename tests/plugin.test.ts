import { describe, expect, it, vi } from "vitest";
import { MockVault, TFile, notices, requestLog } from "obsidian";
import CardsmithPlugin from "../src/main";

function makeApp() {
	const vault = new MockVault();
	let active: TFile | null = null;
	const app = {
		vault,
		workspace: { onLayoutReady: (fn: () => void) => fn(), getActiveFile: () => active, getActiveViewOfType: () => null },
		metadataCache: { getFileCache: () => ({ tags: [{ tag: "#flashcards" }] }) },
		secretStorage: { getSecret: () => null },
	};
	return { app, vault, setActive: (f: TFile) => (active = f) };
}

describe("plugin with mocked Obsidian", () => {
	vi.stubGlobal("window", { setInterval: () => 1, open: () => null });

	it("loads, registers commands without hotkeys or plugin-id prefixes, and makes no network calls on load (nothing configured)", async () => {
		const { app } = makeApp();
		const p = new CardsmithPlugin(app as never, {} as never);
		await p.onload();
		const ids = (p as unknown as { commands: { id: string; hotkeys?: unknown }[] }).commands.map((c) => c.id);
		expect(ids).toEqual(["generate-note", "export-note-anki", "generate-folder", "export-folder-anki", "activate-pro"]);
		expect(ids.some((i) => i.includes("cardsmith"))).toBe(false);
		expect(requestLog).toHaveLength(0);
		expect(p.license.isPro()).toBe(false);
	});

	it("free tier: exports a note's cards to an Anki file offline", async () => {
		const { app, vault, setActive } = makeApp();
		vault.files.set("Bio/Cells.md", "#flashcards\nWhat is ATP?::Energy currency\nThe ==nucleus== holds DNA.\n");
		setActive(new TFile("Bio/Cells.md"));
		const p = new CardsmithPlugin(app as never, {} as never);
		await p.onload();
		const cmd = (p as unknown as { commands: { id: string; checkCallback: (c: boolean) => boolean }[] }).commands.find((c) => c.id === "export-note-anki")!;
		expect(cmd.checkCallback(true)).toBe(true);
		cmd.checkCallback(false);
		await new Promise((r) => setTimeout(r, 10));
		const out = [...vault.files.entries()].find(([k]) => k.startsWith("Cardsmith exports/"));
		expect(out).toBeDefined();
		expect(out![1]).toContain("Basic\tBio\tWhat is ATP?\tEnergy currency\tflashcards");
		expect(out![1]).toContain("Cloze\tBio\tThe {{c1::nucleus}} holds DNA.");
		expect(notices.at(-1)).toMatch(/Exported 2 cards/);
		expect(requestLog).toHaveLength(0);
	});

	it("Pro commands show the upsell instead of running when not licensed", async () => {
		const { app } = makeApp();
		const p = new CardsmithPlugin(app as never, {} as never);
		await p.onload();
		const cmd = (p as unknown as { commands: { id: string; callback: () => void }[] }).commands.find((c) => c.id === "generate-folder")!;
		expect(() => cmd.callback()).not.toThrow();
	});
});
