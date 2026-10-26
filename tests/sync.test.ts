import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEl, MockVault, TFile, mockReply, notices, openedModals, requestLog } from "obsidian";
import CardsmithPlugin from "../src/main";
import { LicenseManager } from "../src/license/manager";
import { classify, cleanFolders, MIN_NOTE_CHARS, pendingText, scanNotes, type SyncIndex } from "../src/core/sync";
import { buildBlock, findBlock, hashText, mergeBlock, stripBlock } from "../src/core/cards";
import { carryHistory } from "../src/core/history";
import { SyncReviewModal } from "../src/ui/sync-review-modal";
import { ReviewModal } from "../src/ui/review-modal";
import { ProModal } from "../src/ui/pro-modal";
import { FolderSuggestModal } from "../src/ui/folder-modal";
import { CardsmithSettingTab } from "../src/settings";

/** Render one settings row (by name) the way Obsidian 1.13+ does, into a fake Setting. */
function settingRow(tab: CardsmithSettingTab, name: string) {
	const item = tab.getSettingDefinitions().flatMap((g) => (g as unknown as { items: { name: string; desc?: string; render: (s: unknown) => void }[] }).items).find((i) => i.name === name);
	if (!item) return null;
	const el = new FakeEl();
	const st = {
		setName: () => st,
		setDesc: () => st,
		addButton: (cb: (b: unknown) => void) => {
			const b = el.createEl("button");
			const bc = {
				setButtonText: (t: string) => (b.setText(t), bc),
				onClick: (fn: () => void) => (b.addEventListener("click", fn), bc),
			};
			cb(bc);
			return st;
		},
	};
	item.render(st);
	return { desc: item.desc ?? "", buttons: el.find((e) => e.tag === "button") };
}

const SR1 = "<!--SR:!2026-11-02,7,250-->";
const SR2 = "<!--SR:!2026-11-03,8,250-->";
const TEXT = " The cell is the basic unit of life and every organism is made of one or more cells.";

vi.stubGlobal("window", { setInterval: () => 1, open: () => null });

/** A note whose cards were made from `body` (hash matches), optionally with extra card lines. */
function withCards(body: string, cardLines: string, hashOf = body): string {
	return `${body}\n\n%% cardsmith:start hash=${hashText(stripBlock(hashOf))} %%\n#flashcards\n\n${cardLines}\n%% cardsmith:end %%\n`;
}

function makeApp() {
	const vault = new MockVault();
	const ready: (() => void)[] = [];
	const app = {
		vault,
		workspace: { onLayoutReady: (fn: () => void) => ready.push(fn), getActiveFile: () => null, getActiveViewOfType: () => null },
		metadataCache: { getFileCache: () => ({ tags: [] }) },
		secretStorage: { getSecret: () => null },
	};
	return { app, vault, ready: async () => { for (const fn of ready.splice(0)) fn(); await flush(); } };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

async function start(app: unknown, data: unknown = null) {
	const p = new CardsmithPlugin(app as never, {} as never);
	(p as unknown as { data: unknown }).data = data;
	await p.onload();
	p.settings.kind = "ollama";
	p.settings.baseUrl = "http://localhost:11434";
	return p;
}

const cmd = (p: CardsmithPlugin, id: string) => (p as unknown as { commands: { id: string; callback: () => void }[] }).commands.find((c) => c.id === id)!;
const status = (p: CardsmithPlugin) => (p as unknown as { statusBar: FakeEl[] }).statusBar[0]!;
const lastModal = <T>(cls: new (...a: never[]) => T): T | undefined => [...openedModals].reverse().find((m) => m instanceof cls) as T | undefined;
const buttons = (m: { contentEl: unknown }) => (m.contentEl as FakeEl).find((e) => e.tag === "button");
const button = (m: { contentEl: unknown }, re: RegExp) => buttons(m).find((b) => re.test(b.text))!;
/** The section of the batch window for one note, found by its name. */
const noteBox = (m: { contentEl: unknown }, name: string) =>
	(m.contentEl as FakeEl).find((e) => e.hasClass("cardsmith-sync-note")).find((b) => b.find((e) => e.tag === "strong")[0]?.text === name)!;

/** Fake local model: cards depend on the note title in the request. */
function model(byTitle: Record<string, { front: string; back: string }[]>) {
	mockReply.fn = (req: { body: string }) => {
		const body = JSON.parse(req.body) as { messages: { content: string }[] };
		const user = body.messages.map((m) => m.content).join("\n");
		const hit = Object.keys(byTitle).find((t) => user.includes(`Title: ${t}`) || user.includes(t));
		return { message: { content: JSON.stringify({ cards: (hit ? byTitle[hit]! : []).map((c) => ({ type: "basic", ...c })) }) } };
	};
}

let pro: ReturnType<typeof vi.spyOn> | null = null;
function setPro(on: boolean) {
	pro?.mockRestore();
	pro = vi.spyOn(LicenseManager.prototype, "isPro").mockReturnValue(on);
}

beforeEach(() => {
	notices.length = 0;
	requestLog.length = 0;
	openedModals.length = 0;
	setPro(true);
});
afterEach(() => {
	mockReply.fn = null;
	pro?.mockRestore();
	pro = null;
});

describe("sync bookkeeping (pure)", () => {
	it("classify: new, fresh, changed, short", () => {
		const body = `# Cells${TEXT}`;
		expect(classify(body)).toBe("new");
		expect(classify(withCards(body, "Q::A"))).toBe("fresh");
		expect(classify(withCards(body + " Edited.", "Q::A", body))).toBe("changed");
		expect(classify("# Tiny\nshort")).toBe("short");
		expect(classify(withCards("x".repeat(MIN_NOTE_CHARS - 1), "Q::A"))).toBe("short");
		// whitespace-only edits do not count as new content (same hash as folder runs)
		expect(classify(withCards(body + "\n\n   ", "Q::A", body))).toBe("fresh");
	});

	it("scanNotes reads only notes without a record or with a new modified time or size", async () => {
		const files: Record<string, string> = { "A.md": `# A${TEXT}`, "B.md": withCards(`# B${TEXT}`, "Q::A"), "C.md": "short" };
		const reads: string[] = [];
		const read = async (p: string) => (reads.push(p), files[p]!);
		const notes = Object.keys(files).map((path, i) => ({ path, stat: { mtime: 100 + i, size: files[path]!.length } }));
		const r1 = await scanNotes(notes, {}, read);
		expect(r1).toMatchObject({ pending: ["A.md"], reads: 3, dirty: true });
		expect(r1.index["C.md"]!.state).toBe("short");
		reads.length = 0;
		const r2 = await scanNotes(notes, r1.index, read);
		expect(r2).toMatchObject({ pending: ["A.md"], reads: 0, dirty: false });
		expect(reads).toEqual([]);
		// B edited: new mtime -> only B is read, and now counts
		files["B.md"] = withCards(`# B${TEXT} More.`, "Q::A", `# B${TEXT}`);
		const notes3 = notes.map((n) => (n.path === "B.md" ? { path: n.path, stat: { mtime: 999, size: files["B.md"]!.length } } : n));
		const r3 = await scanNotes(notes3, r2.index, read);
		expect(reads).toEqual(["B.md"]);
		expect(r3.pending).toEqual(["A.md", "B.md"]);
		// same mtime but different size is also re-read
		reads.length = 0;
		const r4 = await scanNotes(notes3.map((n) => (n.path === "A.md" ? { ...n, stat: { mtime: n.stat.mtime, size: 1 } } : n)), r3.index, read);
		expect(reads).toEqual(["A.md"]);
		expect(r4.dirty).toBe(true);
	});

	it("scanNotes drops notes that left the folders and skips notes that cannot be read", async () => {
		const index: SyncIndex = { "Gone.md": { mtime: 1, size: 1, state: "new" }, "Keep.md": { mtime: 2, size: 2, state: "fresh" } };
		const r = await scanNotes(
			[{ path: "Keep.md", stat: { mtime: 2, size: 2 } }, { path: "Bad.md", stat: { mtime: 3, size: 3 } }],
			index,
			async () => {
				throw new Error("locked");
			},
		);
		expect(Object.keys(r.index)).toEqual(["Keep.md"]);
		expect(r).toMatchObject({ pending: [], reads: 1, dirty: true });
	});

	it("cleanFolders and pendingText", () => {
		expect(cleanFolders([" Course/ ", "Course", "", "/", "Bio//"])).toEqual(["Course", "/", "Bio"]);
		expect(pendingText(1)).toBe("1 note has new content");
		expect(pendingText(7)).toBe("7 notes have new content");
	});

	it("carryHistory lists the questions of reviewed cards that are not in the new set, removed or kept", () => {
		const old = buildBlock([], "#flashcards", "a").replace("\n\n%%", `\n\nQ1::A1\n${SR1}\n\nThe ==nucleus== holds DNA.\n${SR2}\n\nNever reviewed::x\n%%`);
		const fresh = buildBlock([{ type: "basic", front: "Q1", back: "A1" }], "#flashcards", "b");
		const dropped = carryHistory(old, fresh);
		expect(dropped).toMatchObject({ kept: 1, dropped: 1, preserved: 0, unmatched: ["The ==nucleus== holds DNA."] });
		const kept = carryHistory(old, fresh, true);
		expect(kept).toMatchObject({ kept: 1, dropped: 0, preserved: 1, unmatched: ["The ==nucleus== holds DNA."] });
		expect(kept.block).toContain(`The ==nucleus== holds DNA.\n${SR2}\n%% cardsmith:end`);
		expect(carryHistory(old, buildBlock([], "#flashcards", "c")).unmatched).toEqual(["Q1", "The ==nucleus== holds DNA."]);
	});
});

describe("startup cost", () => {
	it("Pro: lists only the synced folders, reads each note once, then only notes whose modified time changed", async () => {
		const { app, vault, ready } = makeApp();
		for (let i = 0; i < 200; i++) vault.addNote(`Course/N${String(i).padStart(3, "0")}.md`, i < 7 ? `# N${i}${TEXT}` : withCards(`# N${i}${TEXT}`, "Q::A"));
		for (let i = 0; i < 300; i++) vault.addNote(`Other/O${i}.md`, `# O${i}${TEXT}`);
		const p = await start(app, { syncedFolders: ["Course"] });
		await ready();
		expect(vault.listCalls).toBe(0); // never getFiles/getMarkdownFiles
		expect(vault.reads).toHaveLength(200);
		expect(vault.reads.every((r) => r.startsWith("Course/"))).toBe(true);
		expect(status(p).text).toBe("7 notes have new content");
		expect(status(p).shown).toBe(true);
		const saved = (p as unknown as { data: { syncIndex: SyncIndex } }).data;
		expect(Object.keys(saved.syncIndex)).toHaveLength(200);
		expect(requestLog).toHaveLength(0);

		// next start, nothing changed: zero reads
		vault.reads.length = 0;
		const p2 = await start(app, saved);
		await ready();
		expect(vault.reads).toEqual([]);
		expect(status(p2).text).toBe("7 notes have new content");

		// three notes edited since: exactly those three are read
		vault.addNote("Course/N100.md", withCards(`# N100${TEXT} New paragraph.`, "Q::A", `# N100${TEXT}`));
		vault.addNote("Course/N101.md", withCards(`# N101${TEXT}`, "Q::A")); // touched, same text
		vault.addNote("Other/O1.md", `# O1${TEXT} edited`); // outside: never read
		vault.addNote("Course/N000.md", vault.files.get("Course/N000.md")!); // touched, still no cards
		const p3 = await start(app, (p2 as unknown as { data: unknown }).data ?? saved);
		await ready();
		expect(vault.reads.sort()).toEqual(["Course/N000.md", "Course/N100.md", "Course/N101.md"]);
		expect(status(p3).text).toBe("8 notes have new content");
		expect(vault.listCalls).toBe(0);
		expect(requestLog).toHaveLength(0);
	});

	it("free: no listing, no reads and no count on startup, even with synced folders saved", async () => {
		setPro(false);
		const { app, vault, ready } = makeApp();
		vault.addNote("Course/A.md", `# A${TEXT}`);
		const p = await start(app, { syncedFolders: ["Course"] });
		await ready();
		expect(vault.reads).toEqual([]);
		expect(status(p).shown).toBe(false);
		expect(p.syncPending).toEqual([]);
	});

	it("no synced folders: nothing is read and the count stays hidden", async () => {
		const { app, vault, ready } = makeApp();
		vault.addNote("Course/A.md", `# A${TEXT}`);
		const p = await start(app);
		await ready();
		expect(vault.reads).toEqual([]);
		expect(status(p).shown).toBe(false);
		cmd(p, "refresh-synced-folders").callback();
		await flush();
		expect(notices.at(-1)).toMatch(/Add a synced folder first/);
	});

	it("the vault root as a synced folder skips the Anki export folder; overlapping folders are listed once", async () => {
		const { app, vault, ready } = makeApp();
		vault.addNote("Course/A.md", `# A${TEXT}`);
		vault.addNote("Course/Sub/B.md", `# B${TEXT}`);
		vault.addNote("Cardsmith exports/E.md", `# E${TEXT}`);
		const p = await start(app, { syncedFolders: ["/", "Course", "Course/Sub", "Missing"] });
		await ready();
		expect(vault.reads.sort()).toEqual(["Course/A.md", "Course/Sub/B.md"]);
		expect(p.syncPending).toEqual(["Course/A.md", "Course/Sub/B.md"]);
	});
});

/** Course/New.md has no cards; Course/Changed.md was edited after its reviewed cards were made; Course/Fresh.md is up to date. */
async function courseVault() {
	const { app, vault, ready } = makeApp();
	vault.addNote("Course/New.md", `# New${TEXT}`);
	vault.addNote(
		"Course/Changed.md",
		withCards(`# Changed${TEXT} Mitochondria make ATP.`, `What is the basic unit of life?::The cell\n${SR1}\n\nOld card?::Old\n${SR2}`, `# Changed${TEXT}`),
	);
	vault.addNote("Course/Fresh.md", withCards(`# Fresh${TEXT}`, `Q::A\n${SR1}`));
	const p = await start(app, { syncedFolders: ["Course"] });
	await ready();
	model({
		"# New": [{ front: "What is a cell?", back: "The basic unit of life" }, { front: "Drop me?", back: "Yes" }],
		"# Changed": [{ front: "What is the basic unit of life?", back: "The cell" }, { front: "What do mitochondria make?", back: "ATP" }],
	});
	return { app, vault, p, ready };
}

describe("synced folder refresh: one reviewed batch", () => {
	it("shows the count, writes nothing before approval, then writes approved cards and keeps review history", async () => {
		const { vault, p } = await courseVault();
		expect(status(p).text).toBe("2 notes have new content");
		const before = new Map(vault.files);
		status(p).click();
		await flush();
		const m = lastModal(SyncReviewModal)!;
		expect(m).toBeDefined();
		expect(m.title).toBe("Refresh 2 notes with new content");
		expect(vault.files).toEqual(before); // nothing written yet
		const text = (m.contentEl as unknown as FakeEl).allText();
		expect(text).toContain("Nothing is saved until you approve it.");
		expect(text).toContain("no cards yet");
		expect(text).toContain("changed since its cards were made");
		// the reviewed card that is not in the new set is listed by its question, and is kept
		expect(text).toContain("This reviewed card is not in the new set. It stays at the end of the cards, with its review history:");
		expect(text).toContain("Old card?");
		expect(text).toContain("Keeps review history for 1 card.");
		expect(requestLog).toHaveLength(2); // Fresh.md was not sent to the model
		// untick "Drop me?" in New.md
		const dropBox = noteBox(m, "New").find((e) => e.tag === "input")[2]!; // [note, card1, card2]
		expect(noteBox(m, "New").find((e) => e.tag === "textarea")[2]!.value).toBe("Drop me?");
		dropBox.checked = false;
		dropBox.fire("change");
		expect(button(m, /^Approve/).text).toBe("Approve 2 notes");
		button(m, /^Approve/).click();
		await flush();
		const n = vault.files.get("Course/New.md")!;
		expect(n).toContain("What is a cell?::The basic unit of life");
		expect(n).not.toContain("Drop me?");
		expect(classify(n)).toBe("fresh");
		const c = vault.files.get("Course/Changed.md")!;
		expect(c).toContain(`What is the basic unit of life?::The cell\n${SR1}`);
		expect(c).toContain("What do mitochondria make?::ATP");
		expect(c).toContain(`Old card?::Old\n${SR2}\n%% cardsmith:end %%`);
		expect(classify(c)).toBe("fresh");
		expect(vault.files.get("Course/Fresh.md")).toBe(before.get("Course/Fresh.md"));
		expect(notices.some((x) => /^Refreshed 2 notes with 3 cards\. Kept review history for 1 card\. 1 reviewed card was not in the new set and stays at the end of the cards, with its review history\./.test(x))).toBe(true);
		expect(status(p).shown).toBe(false); // recount after writing
		expect(p.syncPending).toEqual([]);
	});

	it("matches what a 0.1.5 folder run writes for the same cards (same merge, not a fork)", async () => {
		const { vault, p } = await courseVault();
		const orig = vault.files.get("Course/Changed.md")!;
		cmd(p, "refresh-synced-folders").callback();
		await flush();
		button(lastModal(SyncReviewModal)!, /^Approve/).click();
		await flush();
		const cards = [{ type: "basic" as const, front: "What is the basic unit of life?", back: "The cell" }, { type: "basic" as const, front: "What do mitochondria make?", back: "ATP" }];
		const fresh = buildBlock(cards, "#flashcards", hashText(stripBlock(orig)));
		const b = findBlock(orig)!;
		const expected = orig.slice(0, b.start) + mergeBlock(orig, fresh, true).block + orig.slice(b.end);
		expect(vault.files.get("Course/Changed.md")).toBe(expected);
	});

	it("Cancel writes nothing and says so; the count stays", async () => {
		const { vault, p } = await courseVault();
		const before = new Map(vault.files);
		cmd(p, "refresh-synced-folders").callback();
		await flush();
		button(lastModal(SyncReviewModal)!, /^Cancel$/).click();
		await flush();
		expect(vault.files).toEqual(before);
		expect(notices.at(-1)).toBe("Nothing was saved.");
		expect(status(p).text).toBe("2 notes have new content");
		// closing the window any other way (Esc) is a cancel too
		cmd(p, "refresh-synced-folders").callback();
		await flush();
		lastModal(SyncReviewModal)!.close();
		expect(vault.files).toEqual(before);
		expect(notices.at(-1)).toBe("Nothing was saved.");
	});

	it("unticking a note leaves it exactly as it is; unticking everything disables Approve", async () => {
		const { vault, p } = await courseVault();
		const before = vault.files.get("Course/Changed.md");
		cmd(p, "refresh-synced-folders").callback();
		await flush();
		const m = lastModal(SyncReviewModal)!;
		const changedToggle = noteBox(m, "Changed").find((e) => e.tag === "input")[0]!;
		changedToggle.checked = false;
		changedToggle.fire("change");
		expect(button(m, /^Approve/).text).toBe("Approve 1 note");
		const newToggle = noteBox(m, "New").find((e) => e.tag === "input")[0]!;
		newToggle.checked = false;
		newToggle.fire("change");
		expect(button(m, /^Approve/).disabled).toBe(true);
		newToggle.checked = true;
		newToggle.fire("change");
		button(m, /^Approve/).click();
		await flush();
		expect(vault.files.get("Course/Changed.md")).toBe(before);
		expect(vault.files.get("Course/New.md")).toContain("What is a cell?");
		expect(p.syncPending).toEqual(["Course/Changed.md"]);
	});

	it("an edit made while the window is open still counts as new content afterwards", async () => {
		const { vault, p } = await courseVault();
		cmd(p, "refresh-synced-folders").callback();
		await flush();
		vault.addNote("Course/New.md", `# New${TEXT} Added while reviewing.`);
		button(lastModal(SyncReviewModal)!, /^Approve/).click();
		await flush();
		expect(vault.files.get("Course/New.md")).toContain("Added while reviewing.");
		expect(p.syncPending).toEqual(["Course/New.md"]);
	});

	it("check command announces the count without contacting the model", async () => {
		const { p } = await courseVault();
		cmd(p, "check-synced-folders").callback();
		await flush();
		expect(notices.at(-1)).toMatch(/^2 notes have new content\. Select the count in the status bar/);
		expect(requestLog).toHaveLength(0);
	});

	it("notes the model returns nothing for, or that fail, are reported in the window, not written", async () => {
		const { vault, p } = await courseVault();
		model({ "# New": [{ front: "What is a cell?", back: "Unit" }] }); // nothing for Changed
		const before = vault.files.get("Course/Changed.md");
		cmd(p, "refresh-synced-folders").callback();
		await flush();
		const m = lastModal(SyncReviewModal)!;
		expect(m.title).toBe("Refresh 1 note with new content");
		expect((m.contentEl as unknown as FakeEl).allText()).toContain("The model returned no usable cards for 1 note.");
		button(m, /^Approve/).click();
		await flush();
		expect(vault.files.get("Course/Changed.md")).toBe(before);
	});

	it("settings helpers: add dedupes and recounts; remove recounts", async () => {
		const { app, vault, ready } = makeApp();
		vault.addNote("Course/A.md", `# A${TEXT}`);
		vault.addNote("Bio/B.md", `# B${TEXT}`);
		const p = await start(app);
		await ready();
		await p.addSyncedFolder("Course");
		await p.addSyncedFolder("Course/");
		await p.addSyncedFolder("Bio");
		expect(p.settings.syncedFolders).toEqual(["Course", "Bio"]);
		expect(status(p).text).toBe("2 notes have new content");
		await p.removeSyncedFolder("Bio");
		expect(p.settings.syncedFolders).toEqual(["Course"]);
		expect(status(p).text).toBe("1 note has new content");
		expect(Object.keys(p.settings.syncIndex)).toEqual(["Course/A.md"]);
		// settings: Pro gets "Add folder" (opens the folder picker) and one row per synced folder with Remove
		const tab = new CardsmithSettingTab(p.app, p);
		let rerenders = 0;
		(tab as unknown as { update: () => void }).update = () => rerenders++; // Obsidian 1.13+ re-render
		const row = settingRow(tab, "Synced folders")!;
		expect(row.buttons.map((b) => b.text)).toEqual(["Add folder"]);
		row.buttons[0]!.click();
		lastModal(FolderSuggestModal)!.onChooseItem(vault.getRoot());
		await flush();
		expect(p.settings.syncedFolders).toEqual(["Course", "/"]);
		expect(settingRow(tab, "/ (whole vault)")!.buttons.map((b) => b.text)).toEqual(["Remove"]);
		expect(settingRow(tab, "Course")!.desc).toBe("Synced folder.");
		p.settings.syncedFolders.push("Renamed");
		expect(settingRow(tab, "Renamed")!.desc).toMatch(/^Folder not found\./);
		p.settings.syncedFolders.pop();
		settingRow(tab, "/ (whole vault)")!.buttons[0]!.click();
		await flush();
		expect(p.settings.syncedFolders).toEqual(["Course"]);
		expect(rerenders).toBe(2);
	});
});

describe("free vs Pro", () => {
	async function freeVault(n = 7) {
		setPro(false);
		const { app, vault, ready } = makeApp();
		for (let i = 1; i <= n; i++) vault.addNote(`Course/Note${i}.md`, `# Note${i}${TEXT}`);
		const p = await start(app);
		await ready();
		model(Object.fromEntries([...Array(n)].map((_, i) => [`# Note${i + 1}`, [{ front: `Q${i + 1}?`, back: "A" }]])));
		return { vault, p };
	}

	it("free: the command opens the value-first Pro screen with the one free run; the run reviews up to 5 notes and is then used up", async () => {
		const { vault, p } = await freeVault();
		cmd(p, "refresh-synced-folders").callback();
		const pm = lastModal(ProModal)!;
		expect(pm.title).toBe("Keep this folder in sync");
		expect((pm.contentEl as unknown as FakeEl).allText()).toContain("Nothing is saved until you approve it");
		button(pm, /^Try on 5 notes$/).click();
		const picker = lastModal(FolderSuggestModal)!;
		picker.onChooseItem(vault.getFolderByPath("Course")!);
		await flush();
		expect(requestLog).toHaveLength(5);
		const m = lastModal(SyncReviewModal)!;
		expect(m.title).toBe("Refresh 5 notes with new content");
		expect([...vault.files.values()].some((v) => v.includes("cardsmith:start"))).toBe(false);
		button(m, /^Approve/).click();
		await flush();
		expect([...vault.files.values()].filter((v) => v.includes("cardsmith:start"))).toHaveLength(5);
		expect(p.settings.freeFolderRunUsed).toBe(true);
		expect(notices.at(-1)).toMatch(/^That was your free folder run\./);
		// used up: the Pro screen has no free run any more, and a direct call does nothing
		openedModals.length = 0;
		cmd(p, "refresh-synced-folders").callback();
		expect(buttons(lastModal(ProModal)!).some((b) => /Try on/.test(b.text))).toBe(false);
		const calls = requestLog.length;
		await p.refreshSynced({ folder: vault.getFolderByPath("Course")!, limit: 5 });
		expect(requestLog.length).toBe(calls);
		// the free run is shared with the folder command
		cmd(p, "generate-folder").callback();
		expect(buttons(lastModal(ProModal)!).some((b) => /Try on/.test(b.text))).toBe(false);
	});

	it("free: the 5-note try runs on the user's own provider (here Ollama) and contacts nothing else", async () => {
		const { vault, p } = await freeVault();
		p.settings.kind = "ollama";
		p.settings.baseUrl = "http://localhost:11434";
		requestLog.length = 0;
		await p.refreshSynced({ folder: vault.getFolderByPath("Course")!, limit: 5 });
		expect(requestLog).toHaveLength(5);
		for (const r of requestLog as { url: string }[]) expect(r.url.startsWith("http://localhost:11434/")).toBe(true);
		expect((requestLog as { url: string }[]).some((r) => /workers\.dev|miraforge|openrouter/.test(r.url))).toBe(false);
		button(lastModal(SyncReviewModal)!, /^Approve/).click();
		await flush();
		expect(p.settings.freeFolderRunUsed).toBe(true);
		expect(requestLog).toHaveLength(5);
	});

	it("free: cancelling the free run writes nothing and does not use it up", async () => {
		const { vault, p } = await freeVault(3);
		await p.refreshSynced({ folder: vault.getFolderByPath("Course")!, limit: 5 });
		button(lastModal(SyncReviewModal)!, /^Cancel$/).click();
		expect(p.settings.freeFolderRunUsed).toBe(false);
		expect([...vault.files.values()].some((v) => v.includes("cardsmith:start"))).toBe(false);
	});

	it("free: check command and the settings button open the Pro screen; the status bar never shows a count", async () => {
		const { p } = await freeVault(2);
		cmd(p, "check-synced-folders").callback();
		expect(lastModal(ProModal)!.title).toBe("Keep this folder in sync");
		openedModals.length = 0;
		const row = settingRow(new CardsmithSettingTab(p.app, p), "Synced folders")!;
		expect(row.desc).toMatch(/^Requires Pro\./);
		expect(row.buttons.map((b) => b.text)).toEqual(["See Pro"]);
		row.buttons[0]!.click();
		expect(lastModal(ProModal)!.title).toBe("Keep this folder in sync");
		await p.refreshSynced(); // Pro path refuses without a license
		expect(requestLog).toHaveLength(0);
		expect(status(p).shown).toBe(false);
	});

	it("a Pro license that lapses hides the count and stops checking", async () => {
		const { vault, p } = await courseVault();
		expect(status(p).shown).toBe(true);
		setPro(false);
		vault.reads.length = 0;
		await p.checkSynced(false);
		expect(status(p).shown).toBe(false);
		expect(vault.reads).toEqual([]);
	});
});

describe("single-note review window lists the reviewed cards that will be removed", () => {
	it("lists them by question, updates as cards are unticked, and inserting removes exactly those", async () => {
		const { app } = makeApp();
		const p = await start(app);
		let text = withCards(`# Mito${TEXT} Mitochondria make ATP.`, `What do mitochondria make?::ATP\n${SR1}\n\nOld?::Old\n${SR2}`, "x");
		const editor = {
			getSelection: () => "",
			getValue: () => text,
			offsetToPos: (o: number) => o,
			replaceRange: (r: string, from: number, to?: number) => {
				text = text.slice(0, from) + r + text.slice(to ?? from);
			},
		};
		model({ "Mito": [{ front: "What do mitochondria make?", back: "ATP" }, { front: "Where is ATP made?", back: "In mitochondria" }] });
		await (p as unknown as { generateForEditor: (e: unknown, f: TFile) => Promise<void> }).generateForEditor(editor, new TFile("Mito.md"));
		const m = lastModal(ReviewModal)!;
		expect(m.removedQuestions()).toEqual(["Old?"]);
		const el = m.contentEl as unknown as FakeEl;
		expect(el.allText()).toContain("This reviewed card is not in the new set. Inserting removes it and its review history:");
		expect(el.find((e) => e.tag === "li").map((e) => e.text)).toEqual(["Old?"]);
		// untick the card that carries "What do mitochondria make?" history: now it is listed too
		const first = el.find((e) => e.tag === "input")[0]!;
		first.checked = false;
		first.fire("change");
		expect(m.removedQuestions()).toEqual(["What do mitochondria make?", "Old?"]);
		expect(el.allText()).toContain("These 2 reviewed cards are not in the new set. Inserting removes them and their review history:");
		// editing a question so it no longer matches also shows up
		first.checked = true;
		first.fire("change");
		const q = el.find((e) => e.tag === "textarea")[0]!;
		q.value = "What do mitochondria produce?";
		q.fire("input");
		expect(m.removedQuestions()).toEqual(["What do mitochondria make?", "Old?"]);
		q.value = "What do mitochondria make?";
		q.fire("input");
		button(m, /^Insert/).click();
		expect(text).toContain(`What do mitochondria make?::ATP\n${SR1}`);
		expect(text).not.toContain("Old?");
		expect(notices.at(-1)).toMatch(/^Added 2 cards\. Kept review history for 1 card\. 1 card with review history was removed/);
	});

	it("shows no list when no reviewed card would be removed", async () => {
		const { app } = makeApp();
		const p = await start(app);
		let text = withCards(`# Mito${TEXT}`, `What do mitochondria make?::ATP\n${SR1}`, "x");
		const editor = { getSelection: () => "", getValue: () => text, offsetToPos: (o: number) => o, replaceRange: (r: string, f: number, t?: number) => (text = text.slice(0, f) + r + text.slice(t ?? f)) };
		model({ "Mito": [{ front: "What do mitochondria make?", back: "ATP" }] });
		await (p as unknown as { generateForEditor: (e: unknown, f: TFile) => Promise<void> }).generateForEditor(editor, new TFile("Mito.md"));
		const m = lastModal(ReviewModal)!;
		expect(m.removedQuestions()).toEqual([]);
		expect((m.contentEl as unknown as FakeEl).find((e) => e.tag === "li")).toHaveLength(0);
	});
});
