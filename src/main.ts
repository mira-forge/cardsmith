import { MarkdownView, Notice, Plugin, TFile, TFolder, normalizePath, requestUrl, type Editor } from "obsidian";
import { CardsmithSettingTab, DEFAULT_SETTINGS, type CardsmithSettings } from "./settings";
import { complete, type HttpFn, type ModelConfig } from "./ai/providers";
import { buildBlock, findBlock, hashText, mergeBlock, parseCards, stripBlock, upsertBlock, type Card } from "./core/cards";
import { buildMessages, MAX_INPUT_CHARS } from "./core/prompt";
import { markdownUnder } from "./core/scope";
import { classify, cleanFolders, MIN_NOTE_CHARS, needsRefresh, pendingText, scanNotes } from "./core/sync";
import { allowedTypes, cardCap, FREE_FOLDER_RUN_NOTES, plural, type ProFeature } from "./core/features";
import { deckFromPath, parseSrCards, toAnkiTsv, type ExportCard } from "./core/anki";
import { LicenseManager } from "./license/manager";
import { ServerLicenseProvider } from "./license/server-provider";
import { StripeLicenseProvider } from "./license/stripe-provider";
import { LicenseError } from "./license/types";
import { ITCH_LICENSE_SERVER_URL, LICENSE_PUBLIC_JWK, STRIPE_LICENSE_SERVER_URL } from "./config";
import { ReviewModal } from "./ui/review-modal";
import { SyncReviewModal, type SyncApproval, type SyncItem } from "./ui/sync-review-modal";
import { FolderSuggestModal } from "./ui/folder-modal";
import { ProModal } from "./ui/pro-modal";
import { KeyModal } from "./ui/key-modal";

/** Obsidian's requestUrl does not apply browser CORS rules, which local Ollama and most APIs need. */
const obsidianHttp: HttpFn = async (req) => {
	const res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false });
	let json: unknown = null;
	try {
		json = res.json;
	} catch {
		json = null;
	}
	return { status: res.status, json, text: typeof res.text === "string" ? res.text : "" };
};

/** Cards with a Spaced Repetition schedule in the note's Cardsmith block. */
/** Notice text for reviewed cards that the new set did not include and that were left in place. */
function preservedText(n: number): string {
	return `${plural(n, "reviewed card")} ${n === 1 ? "was" : "were"} not in the new set and ${n === 1 ? "stays" : "stay"} at the end of the cards, with ${n === 1 ? "its" : "their"} review history. Delete ${n === 1 ? "it" : "them"} by hand if you no longer want ${n === 1 ? "it" : "them"}.`;
}

function historyCount(note: string): number {
	const b = findBlock(note);
	return b ? (note.slice(b.start, b.end).match(/<!--SR:/g) ?? []).length : 0;
}

export default class CardsmithPlugin extends Plugin {
	settings: CardsmithSettings = { ...DEFAULT_SETTINGS };
	license!: LicenseManager;
	private busy = false;
	refreshSettingTab?: () => void;
	/** Status bar count of synced-folder notes with new content (hidden when there are none). */
	private statusEl: HTMLElement | null = null;
	/** Paths found by the last synced-folder check. */
	syncPending: string[] = [];
	private scanning: Promise<void> | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.license = new LicenseManager(
			[
				new StripeLicenseProvider(obsidianHttp, STRIPE_LICENSE_SERVER_URL, LICENSE_PUBLIC_JWK),
				new ServerLicenseProvider(obsidianHttp, ITCH_LICENSE_SERVER_URL, LICENSE_PUBLIC_JWK),
			],
			() => this.settings.license,
			async (l) => {
				this.settings.license = l;
				await this.saveSettings();
			},
		);
		await this.license.restore();
		// Re-check with the payment provider at most once a day (the manager enforces the 24h limit).
		this.app.workspace.onLayoutReady(() => void this.license.revalidate());
		this.registerInterval(window.setInterval(() => void this.license.revalidate(), 6 * 60 * 60 * 1000));

		this.addSettingTab(new CardsmithSettingTab(this.app, this));
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("cardsmith-sync-status");
		this.statusEl.setAttr("aria-label", "Refresh these notes in one reviewed batch");
		this.statusEl.toggle(false);
		this.statusEl.addEventListener("click", () => void this.refreshSynced());
		// Synced folders (Pro): one cheap check once the vault is loaded. Unchanged notes are not read.
		this.app.workspace.onLayoutReady(() => void this.checkSynced(false));
		this.addRibbonIcon("layers", "Generate flashcards from this note", () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view?.file) void this.generateForEditor(view.editor, view.file);
			else new Notice("Open a note first.");
		});

		this.addCommand({
			id: "generate-note",
			name: "Generate flashcards from this note or selection",
			editorCheckCallback: (checking, editor, ctx) => {
				const file = ctx.file;
				if (!file) return false;
				if (!checking) void this.generateForEditor(editor, file);
				return true;
			},
		});
		this.addCommand({
			id: "export-note-anki",
			name: "Export this note's flashcards to Anki",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.exportFiles([file], file.basename);
				return true;
			},
		});
		this.addCommand({
			id: "generate-folder",
			name: "Generate flashcards for every note in a folder",
			callback: () =>
				this.requirePro(
					"batchFolder",
					() => new FolderSuggestModal(this.app, (f) => void this.generateFolder(f)).open(),
					this.settings.freeFolderRunUsed ? undefined : () => new FolderSuggestModal(this.app, (f) => void this.generateFolder(f, FREE_FOLDER_RUN_NOTES)).open(),
				),
		});
		this.addCommand({
			id: "export-folder-anki",
			name: "Export a folder's flashcards to Anki",
			callback: () =>
				this.requirePro("bulkExport", () =>
					new FolderSuggestModal(this.app, (f) => void this.exportFiles(this.markdownIn(f), f.isRoot() ? "Vault" : f.name)).open(),
				),
		});
		this.addCommand({
			id: "check-synced-folders",
			name: "Check synced folders for notes with new content",
			callback: () => this.requirePro("syncFolders", () => void this.checkSynced(true), this.freeSyncRun()),
		});
		this.addCommand({
			id: "refresh-synced-folders",
			name: "Refresh notes with new content in synced folders",
			callback: () => this.requirePro("syncFolders", () => void this.refreshSynced(), this.freeSyncRun()),
		});
		this.addCommand({
			id: "activate-pro",
			name: "Activate license key",
			callback: () => new KeyModal(this.app, (k) => this.activateLicense(k)).open(),
		});
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<CardsmithSettings> | null);
		// own copies, so the defaults are never mutated
		this.settings.syncedFolders = cleanFolders(Array.isArray(this.settings.syncedFolders) ? this.settings.syncedFolders : []);
		this.settings.syncIndex = { ...(this.settings.syncIndex ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async activateLicense(raw: string): Promise<void> {
		if (!raw.trim()) {
			new Notice("Paste your license key first.");
			return;
		}
		try {
			await this.license.activate(raw);
			new Notice("License activated. Thank you for your support!");
			this.refreshSettingTab?.();
		} catch (e) {
			new Notice(e instanceof LicenseError ? e.message : "Could not activate the license.");
		}
	}

	private requirePro(feature: ProFeature, run: () => void, tryFree?: () => void): void {
		if (this.license.isPro()) run();
		else this.showPro(feature, tryFree);
	}

	/** The value-first Pro screen for `feature`. */
	showPro(feature: ProFeature, tryFree?: () => void): void {
		new ProModal(this.app, feature, this.license.salesOpen(), () => new KeyModal(this.app, (k) => this.activateLicense(k)).open(), tryFree).open();
	}

	/** The free taste of synced folders: one reviewed refresh of up to 5 notes in a folder, once per vault (shared with the free folder run). */
	freeSyncRun(): (() => void) | undefined {
		if (this.settings.freeFolderRunUsed) return undefined;
		return () => new FolderSuggestModal(this.app, (f) => void this.refreshSynced({ folder: f, limit: FREE_FOLDER_RUN_NOTES })).open();
	}

	private modelConfig(): ModelConfig {
		const s = this.settings;
		const apiKey = s.kind === "ollama" || !s.apiKeySecret ? "" : (this.app.secretStorage.getSecret(s.apiKeySecret) ?? "");
		return { kind: s.kind, baseUrl: s.baseUrl, model: s.model, apiKey, temperature: s.temperature };
	}

	/** Ask the model for cards for one piece of text. `truncated` is set when only the first part of a long note was sent. */
	private async makeCards(title: string, text: string): Promise<{ cards: Card[]; truncated: boolean }> {
		const pro = this.license.isPro();
		const types = allowedTypes(pro, { reversed: this.settings.useReversed, cloze: this.settings.useCloze });
		const max = cardCap(pro, this.settings.maxCards);
		const { system, user, truncated } = buildMessages(title, text, {
			maxCards: max,
			types,
			language: this.settings.language,
			extraInstructions: pro ? this.settings.extraInstructions : "",
		});
		const raw = await complete(obsidianHttp, this.modelConfig(), system, user);
		return { cards: parseCards(raw, types).slice(0, max), truncated };
	}

	private async generateForEditor(editor: Editor, file: TFile): Promise<void> {
		if (this.busy) return;
		const selection = editor.getSelection();
		const full = editor.getValue();
		const source = selection.trim() ? selection : stripBlock(full);
		if (source.trim().length < 40) {
			new Notice("There is not enough text here to make cards from.");
			return;
		}
		this.busy = true;
		const notice = new Notice("Cardsmith is writing cards…", 0);
		let cards: Card[];
		let truncated = false;
		try {
			({ cards, truncated } = await this.makeCards(file.basename, source));
		} catch (e) {
			notice.hide();
			this.busy = false;
			new Notice(e instanceof Error ? e.message : "Card generation failed.", 8000);
			return;
		}
		notice.hide();
		this.busy = false;
		if (truncated) {
			new Notice(
				`This ${selection.trim() ? "selection" : "note"} is longer than ${MAX_INPUT_CHARS.toLocaleString("en-US")} characters, so only the first ${MAX_INPUT_CHARS.toLocaleString("en-US")} were used. Cards for the rest aren't included.`,
				12000,
			);
		}
		if (!cards.length) {
			new Notice("The model did not return any usable cards. Try a longer section or another model.");
			return;
		}
		// Without the review window the user never sees which reviewed cards would go, so keep them.
		const keepReviewed = !this.settings.reviewBeforeInsert;
		const write = (chosen: Card[]) => {
			const current = editor.getValue();
			const fresh = buildBlock(chosen, this.settings.deckTag, hashText(stripBlock(current)));
			const existing = findBlock(current);
			// keep Spaced Repetition review history for cards that are still there
			const { block, kept, dropped, preserved } = mergeBlock(current, fresh, keepReviewed);
			if (existing) {
				editor.replaceRange(block, editor.offsetToPos(existing.start), editor.offsetToPos(existing.end));
			} else {
				const end = editor.offsetToPos(current.length);
				const sep = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
				editor.replaceRange(`${sep}${block}\n`, end);
			}
			const history = kept || dropped ? ` Kept review history for ${plural(kept, "card")}.` : "";
			const lost = dropped ? ` ${plural(dropped, "card")} with review history ${dropped === 1 ? "was" : "were"} removed, so ${dropped === 1 ? "its" : "their"} history is gone.` : "";
			const old = preserved ? ` ${preservedText(preserved)}` : "";
			new Notice(`Added ${plural(chosen.length, "card")}.${history}${lost}${old}`, dropped || preserved ? 10000 : 5000);
		};
		// questions of reviewed cards that inserting the chosen cards would remove (same merge as write())
		const removedFor = (chosen: Card[]) => mergeBlock(editor.getValue(), buildBlock(chosen, this.settings.deckTag, "00000000"), keepReviewed).unmatched;
		if (this.settings.reviewBeforeInsert) new ReviewModal(this.app, cards, file.basename, write, historyCount(full), removedFor).open();
		else write(cards);
	}

	/** Notes under the chosen folder only (walks that folder's children, never the whole vault). */
	private markdownIn(folder: TFolder): TFile[] {
		return markdownUnder(folder, this.settings.exportFolder);
	}

	/**
	 * Pro: generate for every note in a folder, skipping notes whose cards are up to date.
	 * With `freeLimit` (free users, once per vault): stop after that many notes got cards.
	 */
	private async generateFolder(folder: TFolder, freeLimit?: number): Promise<void> {
		if (this.busy) return;
		if (freeLimit && this.settings.freeFolderRunUsed) return;
		const files = this.markdownIn(folder);
		if (!files.length) {
			new Notice("No notes in that folder.");
			return;
		}
		this.busy = true;
		const notice = new Notice(`Cardsmith: 0 of ${files.length} notes`, 0);
		let made = 0;
		let notesDone = 0;
		let skipped = 0;
		let kept = 0;
		let preserved = 0;
		let cut = 0;
		const failed: string[] = [];
		for (let i = 0; i < files.length; i++) {
			if (freeLimit && notesDone >= freeLimit) break;
			const file = files[i]!;
			notice.setMessage(`Cardsmith: ${i + 1} of ${files.length} notes (${file.basename})`);
			const content = await this.app.vault.cachedRead(file);
			const body = stripBlock(content);
			const hash = hashText(body);
			if (findBlock(content)?.hash === hash || body.trim().length < MIN_NOTE_CHARS) {
				skipped++;
				continue;
			}
			try {
				const { cards, truncated } = await this.makeCards(file.basename, body);
				if (truncated) cut++;
				if (!cards.length) {
					skipped++;
					continue;
				}
				await this.app.vault.process(file, (data) => {
					const fresh = buildBlock(cards, this.settings.deckTag, hashText(stripBlock(data)));
					// nobody reviews folder runs card by card, so reviewed cards are never removed here
					const r = mergeBlock(data, fresh, true);
					kept += r.kept;
					preserved += r.preserved;
					return upsertBlock(data, fresh, true);
				});
				made += cards.length;
				notesDone++;
			} catch (e) {
				failed.push(file.basename);
				if (e instanceof Error && /API key|rate limiting|reach/.test(e.message)) {
					new Notice(e.message, 8000);
					break;
				}
			}
		}
		notice.hide();
		this.busy = false;
		const tail = failed.length ? ` ${failed.length} failed: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}.` : "";
		const skip = skipped ? ` ${plural(skipped, "note")} ${skipped === 1 ? "was" : "were"} already up to date or too short.` : "";
		const hist = kept ? ` Kept review history for ${plural(kept, "card")}.` : "";
		const old = preserved ? ` ${preservedText(preserved)}` : "";
		const long = cut ? ` ${plural(cut, "note")} ${cut === 1 ? "was" : "were"} longer than ${MAX_INPUT_CHARS.toLocaleString("en-US")} characters; only the first ${MAX_INPUT_CHARS.toLocaleString("en-US")} were used.` : "";
		new Notice(`Cardsmith made ${plural(made, "card")} from ${plural(notesDone, "note")}.${skip}${hist}${old}${long}${tail}`, 10000);
		if (freeLimit && notesDone > 0) {
			this.settings.freeFolderRunUsed = true;
			await this.saveSettings();
			new Notice(
				"That was your free folder run. With a license, whole folders run in one go, and later only the notes you change are refreshed. It costs $3/month, tax included.",
				15000,
			);
		}
	}

	/** Synced folders that still exist. The vault root is "/". A renamed or deleted folder is skipped. */
	private syncedFolderObjects(): TFolder[] {
		const out: TFolder[] = [];
		for (const p of this.settings.syncedFolders) {
			const f = p === "/" ? this.app.vault.getRoot() : this.app.vault.getFolderByPath(p);
			if (f) out.push(f);
		}
		return out;
	}

	/** Markdown notes in the synced folders only (each folder walked on its own, duplicates removed). */
	syncedNotes(): TFile[] {
		const seen = new Map<string, TFile>();
		for (const folder of this.syncedFolderObjects()) for (const f of this.markdownIn(folder)) seen.set(f.path, f);
		return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
	}

	async addSyncedFolder(path: string): Promise<void> {
		this.settings.syncedFolders = cleanFolders([...this.settings.syncedFolders, path]);
		await this.saveSettings();
		await this.checkSynced(false);
	}

	async removeSyncedFolder(path: string): Promise<void> {
		this.settings.syncedFolders = this.settings.syncedFolders.filter((p) => p !== path);
		await this.saveSettings();
		await this.checkSynced(false);
	}

	private showCount(): void {
		if (!this.statusEl) return;
		const n = this.syncPending.length;
		this.statusEl.setText(n ? pendingText(n) : "");
		this.statusEl.toggle(n > 0);
	}

	/**
	 * Pro: count the notes in the synced folders that changed since their cards were made or have no cards
	 * yet. A note is read only if its modified time or size changed since it was last checked; the record is
	 * kept in data.json. Free (or no synced folders): nothing is listed or read, and the count is hidden.
	 */
	checkSynced(announce: boolean): Promise<void> {
		if (!this.scanning) {
			this.scanning = this.runCheck(announce).finally(() => (this.scanning = null));
			return this.scanning;
		}
		return this.scanning.then(() => (announce ? this.announce() : undefined));
	}

	private announce(): void {
		const n = this.syncPending.length;
		if (!this.settings.syncedFolders.length) new Notice("Add a synced folder first, in this plugin's settings.");
		else if (n) new Notice(`${pendingText(n)}. Select the count in the status bar, or run "Refresh notes with new content in synced folders", to review new cards for them.`, 8000);
		else new Notice("Every note in your synced folders has up-to-date cards.");
	}

	private async runCheck(announce: boolean): Promise<void> {
		if (!this.license.isPro() || !this.settings.syncedFolders.length) {
			this.syncPending = [];
			this.showCount();
			if (announce) this.announce();
			return;
		}
		const files = this.syncedNotes();
		const byPath = new Map(files.map((f) => [f.path, f]));
		const r = await scanNotes(
			files.map((f) => ({ path: f.path, stat: f.stat })),
			this.settings.syncIndex,
			(p) => this.app.vault.cachedRead(byPath.get(p)!),
		);
		this.syncPending = r.pending;
		if (r.dirty) {
			this.settings.syncIndex = r.index;
			await this.saveSettings();
		}
		this.showCount();
		if (announce) this.announce();
	}

	/**
	 * Make new cards for the synced-folder notes with new content and show them in one review window.
	 * Nothing is written until the user approves. With `folder` and `limit` (the free taste): only that
	 * folder, at most `limit` notes, once per vault.
	 */
	async refreshSynced(opts: { folder?: TFolder; limit?: number } = {}): Promise<void> {
		if (this.busy) return;
		const free = opts.limit !== undefined;
		let paths: string[];
		if (free) {
			if (this.settings.freeFolderRunUsed || !opts.folder) return;
			const files = this.markdownIn(opts.folder);
			const byPath = new Map(files.map((f) => [f.path, f]));
			const r = await scanNotes(files.map((f) => ({ path: f.path, stat: f.stat })), {}, (p) => this.app.vault.cachedRead(byPath.get(p)!));
			paths = r.pending.slice(0, opts.limit);
		} else {
			if (!this.license.isPro()) return;
			if (!this.settings.syncedFolders.length) {
				new Notice("Add a synced folder first, in this plugin's settings.");
				return;
			}
			await this.checkSynced(false);
			paths = [...this.syncPending];
		}
		if (!paths.length) {
			new Notice(free ? "Every note in that folder already has up-to-date cards, or is too short." : "Every note in your synced folders has up-to-date cards.");
			return;
		}
		this.busy = true;
		const notice = new Notice(`Cardsmith: 0 of ${paths.length} notes`, 0);
		const items: (SyncItem & { hash: string })[] = [];
		const failed: string[] = [];
		let empty = 0;
		let cut = 0;
		for (let i = 0; i < paths.length; i++) {
			const file = this.app.vault.getFileByPath(paths[i]!);
			if (!file) continue;
			notice.setMessage(`Cardsmith: ${i + 1} of ${paths.length} notes (${file.basename})`);
			const content = await this.app.vault.cachedRead(file);
			const state = classify(content);
			if (!needsRefresh(state)) continue;
			const body = stripBlock(content);
			const hash = hashText(body);
			try {
				const { cards, truncated } = await this.makeCards(file.basename, body);
				if (truncated) cut++;
				if (!cards.length) {
					empty++;
					continue;
				}
				items.push({
					path: file.path,
					name: file.basename,
					reason: state === "new" ? "new" : "changed",
					cards,
					hash,
					// same merge as the write below (0.1.5 logic): reviewed cards are never removed in a refresh
					preview: (chosen) => {
						const r = mergeBlock(content, buildBlock(chosen, this.settings.deckTag, hash), true);
						return { kept: r.kept, stays: r.unmatched };
					},
				});
			} catch (e) {
				failed.push(file.basename);
				if (e instanceof Error && /API key|rate limiting|reach/.test(e.message)) {
					new Notice(e.message, 8000);
					break;
				}
			}
		}
		notice.hide();
		this.busy = false;
		const lines: string[] = [];
		if (failed.length) lines.push(`${plural(failed.length, "note")} failed and ${failed.length === 1 ? "is" : "are"} not listed: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}.`);
		if (empty) lines.push(`The model returned no usable cards for ${plural(empty, "note")}.`);
		if (cut) lines.push(`${plural(cut, "note")} ${cut === 1 ? "was" : "were"} longer than ${MAX_INPUT_CHARS.toLocaleString("en-US")} characters; only the first ${MAX_INPUT_CHARS.toLocaleString("en-US")} were used.`);
		if (!items.length) {
			new Notice(`Nothing to review.${lines.length ? " " + lines.join(" ") : ""}`, 8000);
			return;
		}
		new SyncReviewModal(
			this.app,
			items,
			(approved) => this.applySync(approved as (SyncApproval & { item: SyncItem & { hash: string } })[], free),
			() => new Notice("Nothing was saved."),
			lines,
		).open();
	}

	/** Write the approved notes, with the same merge as folder runs: review history kept, reviewed cards never removed. */
	private async applySync(approved: (SyncApproval & { item: SyncItem & { hash: string } })[], free: boolean): Promise<void> {
		let notes = 0;
		let cards = 0;
		let kept = 0;
		let preserved = 0;
		for (const { item, cards: chosen } of approved) {
			const file = this.app.vault.getFileByPath(item.path);
			if (!file) continue;
			// the hash is of the text the cards were made from, so later edits still show as new content
			const fresh = buildBlock(chosen, this.settings.deckTag, item.hash);
			await this.app.vault.process(file, (data) => {
				const r = mergeBlock(data, fresh, true);
				kept += r.kept;
				preserved += r.preserved;
				return upsertBlock(data, fresh, true);
			});
			notes++;
			cards += chosen.length;
		}
		const hist = kept ? ` Kept review history for ${plural(kept, "card")}.` : "";
		const old = preserved ? ` ${preservedText(preserved)}` : "";
		new Notice(`Refreshed ${plural(notes, "note")} with ${plural(cards, "card")}.${hist}${old}`, preserved ? 10000 : 6000);
		if (free && notes > 0) {
			this.settings.freeFolderRunUsed = true;
			await this.saveSettings();
			new Notice(
				"That was your free folder run. With a license, pick folders once: Cardsmith counts the notes with new content when Obsidian starts, and you refresh them in one reviewed batch. It costs $3/month, tax included.",
				15000,
			);
		}
		await this.checkSynced(false);
	}

	/** Offline: collect Spaced Repetition-format cards and write an Anki import file into the vault. */
	private async exportFiles(files: TFile[], label: string): Promise<void> {
		const all: ExportCard[] = [];
		for (const f of files) {
			const text = await this.app.vault.cachedRead(f);
			const tags = (this.app.metadataCache.getFileCache(f)?.tags ?? []).map((t) => t.tag);
			for (const c of parseSrCards(text)) all.push({ ...c, deck: deckFromPath(f.path), tags });
		}
		if (!all.length) {
			new Notice("No flashcards found to export.");
			return;
		}
		const dir = normalizePath(this.settings.exportFolder);
		if (!this.app.vault.getFolderByPath(dir)) await this.app.vault.createFolder(dir);
		const stamp = new Date().toISOString().slice(0, 10);
		const path = normalizePath(`${dir}/${label.replace(/[\\/:*?"<>|]/g, "-")} ${stamp}.txt`);
		const existing = this.app.vault.getFileByPath(path);
		const tsv = toAnkiTsv(all);
		if (existing) await this.app.vault.modify(existing, tsv);
		else await this.app.vault.create(path, tsv);
		new Notice(`Exported ${plural(all.length, "card")} to ${path}. In Anki, use File > Import.`, 8000);
	}
}
