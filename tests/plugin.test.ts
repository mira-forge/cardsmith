import { describe, expect, it, vi } from "vitest";
import { MockVault, TFile, TFolder, mockReply, notices, requestLog } from "obsidian";
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
		expect(ids).toEqual(["generate-note", "export-note-anki", "generate-folder", "export-folder-anki", "check-synced-folders", "refresh-synced-folders", "activate-pro"]);
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

	it("free folder run: once per vault, up to 5 notes, keeps review history", async () => {
		const { app, vault } = makeApp();
		const folder = new TFolder("Course");
		const long = " The cell is the basic unit of life and every organism is made of one or more cells.";
		for (let i = 1; i <= 7; i++) {
			const path = `Course/Note${i}.md`;
			vault.files.set(path, `# Note ${i}${long}`);
			folder.children.push(new TFile(path));
		}
		// Note1 already has cards that were reviewed in Spaced Repetition
		vault.files.set(
			"Course/Note1.md",
			`# Note 1${long}\n\n%% cardsmith:start hash=00000000 %%\n#flashcards\n\nWhat is the basic unit of life?::The cell\n<!--SR:!2026-11-02,7,250-->\n\nOld card?::Old\n<!--SR:!2026-11-03,8,250-->\n%% cardsmith:end %%\n`,
		);
		const p = new CardsmithPlugin(app as never, {} as never);
		await p.onload();
		p.settings.kind = "ollama";
		p.settings.baseUrl = "http://localhost:11434";
		mockReply.fn = () => ({ message: { content: JSON.stringify({ cards: [{ type: "basic", front: "What is the basic unit of life?", back: "The cell" }, { type: "cloze", front: "Every ==organism== is made of cells." }] }) } });
		p.settings.useCloze = true;
		try {
			const gen = (p as unknown as { generateFolder: (f: TFolder, n?: number) => Promise<void> }).generateFolder.bind(p);
			await gen(folder, 5);
			const written = [...vault.files.entries()].filter(([, v]) => v.includes("cardsmith:start"));
			expect(written).toHaveLength(5);
			expect(vault.files.get("Course/Note6.md")).not.toContain("cardsmith:start");
			const n1 = vault.files.get("Course/Note1.md")!;
			expect(n1).toContain("What is the basic unit of life?::The cell\n<!--SR:!2026-11-02,7,250-->");
			// a reviewed card that is not in the new set is kept, never removed unseen
			expect(n1).toContain("Old card?::Old\n<!--SR:!2026-11-03,8,250-->\n%% cardsmith:end %%");
			expect(n1).toContain("Every ==organism== is made of cells."); // cloze on free
			expect(notices.some((m) => /made 10 cards from 5 notes\. Kept review history for 1 card\. 1 reviewed card was not in the new set and stays at the end of the cards/.test(m))).toBe(true);
			expect(notices.at(-1)).toMatch(/free folder run/);
			expect(p.settings.freeFolderRunUsed).toBe(true);
			// a second free run does nothing
			const before = requestLog.length;
			await gen(folder, 5);
			expect(requestLog.length).toBe(before);
			expect(vault.files.get("Course/Note6.md")).not.toContain("cardsmith:start");
		} finally {
			mockReply.fn = null;
		}
	});
	it("editor run with the review window off keeps reviewed cards that are not in the new set; long notes say the rest is not included", async () => {
		const { app } = makeApp();
		const p = new CardsmithPlugin(app as never, {} as never);
		await p.onload();
		p.settings.kind = "ollama";
		p.settings.baseUrl = "http://localhost:11434";
		p.settings.reviewBeforeInsert = false;
		const long = " Mitochondria make ATP for the cell.".repeat(800); // > 24,000 characters
		let text = `# Mito${long}\n\n%% cardsmith:start hash=00000000 %%\n#flashcards\n\nWhat do mitochondria make?::ATP\n<!--SR:!2026-11-02,7,250-->\n\nOld?::Old\n<!--SR:!2026-11-03,8,250-->\n%% cardsmith:end %%\n`;
		const editor = {
			getSelection: () => "",
			getValue: () => text,
			offsetToPos: (o: number) => o,
			replaceRange: (r: string, from: number, to?: number) => {
				text = text.slice(0, from) + r + text.slice(to ?? from);
			},
		};
		mockReply.fn = () => ({ message: { content: JSON.stringify({ cards: [{ type: "basic", front: "What do mitochondria make?", back: "ATP" }, { type: "basic", front: "Where is ATP made?", back: "In mitochondria" }] }) } });
		try {
			const run = (p as unknown as { generateForEditor: (e: unknown, f: TFile) => Promise<void> }).generateForEditor.bind(p);
			await run(editor, new TFile("Mito.md"));
			expect(text).toContain("What do mitochondria make?::ATP\n<!--SR:!2026-11-02,7,250-->");
			expect(text).toContain("Where is ATP made?::In mitochondria");
			expect(text).toContain("Old?::Old\n<!--SR:!2026-11-03,8,250-->\n%% cardsmith:end %%");
			expect(notices.some((m) => /only the first 24,000 were used\. Cards for the rest aren't included\.$/.test(m))).toBe(true);
			expect(notices.some((m) => /Select the rest/.test(m))).toBe(false);
			expect(notices.some((m) => /^Added 2 cards\. Kept review history for 1 card\. 1 reviewed card was not in the new set and stays at the end of the cards, with its review history\./.test(m))).toBe(true);
		} finally {
			mockReply.fn = null;
		}
	});
});
