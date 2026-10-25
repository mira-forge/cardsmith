import { MarkdownView, Notice, Platform, Plugin, TFile, TFolder, normalizePath, requestUrl, type Editor } from "obsidian";
import { CardsmithSettingTab, DEFAULT_SETTINGS, type CardsmithSettings } from "./settings";
import { complete, type HttpFn, type ModelConfig } from "./ai/providers";
import { buildBlock, findBlock, hashText, parseCards, stripBlock, upsertBlock, type Card } from "./core/cards";
import { buildMessages } from "./core/prompt";
import { allowedTypes, cardCap, PRO_FEATURES, type ProFeature } from "./core/features";
import { deckFromPath, parseSrCards, toAnkiTsv, type ExportCard } from "./core/anki";
import { LicenseManager } from "./license/manager";
import { ServerLicenseProvider } from "./license/server-provider";
import { PolarLicenseProvider } from "./license/polar-provider";
import { StripeLicenseProvider } from "./license/stripe-provider";
import { LicenseError } from "./license/types";
import { ITCH_LICENSE_SERVER_URL, LICENSE_PUBLIC_JWK, LICENSE_RAIL, POLAR, STRIPE_LICENSE_SERVER_URL } from "./config";
import { ReviewModal } from "./ui/review-modal";
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

export default class CardsmithPlugin extends Plugin {
	settings: CardsmithSettings = { ...DEFAULT_SETTINGS };
	license!: LicenseManager;
	private busy = false;
	refreshSettingTab?: () => void;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.license = new LicenseManager(
			[
				// One subscription rail per build (both use CARDSMITH- keys); see LICENSE_RAIL in config.ts.
				LICENSE_RAIL === "polar"
					? new PolarLicenseProvider(obsidianHttp, {
							...POLAR,
							deviceLabel: `${POLAR.deviceLabel} (${Platform.isMobile ? "mobile" : "desktop"})`,
						})
					: new StripeLicenseProvider(obsidianHttp, STRIPE_LICENSE_SERVER_URL, LICENSE_PUBLIC_JWK),
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
			callback: () => this.requirePro("batchFolder", () => new FolderSuggestModal(this.app, (f) => void this.generateFolder(f)).open()),
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
			id: "activate-pro",
			name: "Activate license key",
			callback: () => new KeyModal(this.app, (k) => this.activateLicense(k)).open(),
		});
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<CardsmithSettings> | null);
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

	private requirePro(feature: ProFeature, run: () => void): void {
		if (this.license.isPro()) run();
		else new ProModal(this.app, PRO_FEATURES[feature], this.license.salesOpen(), () => new KeyModal(this.app, (k) => this.activateLicense(k)).open()).open();
	}

	private modelConfig(): ModelConfig {
		const s = this.settings;
		const apiKey = s.kind === "ollama" || !s.apiKeySecret ? "" : (this.app.secretStorage.getSecret(s.apiKeySecret) ?? "");
		return { kind: s.kind, baseUrl: s.baseUrl, model: s.model, apiKey, temperature: s.temperature };
	}

	/** Ask the model for cards for one piece of text. */
	private async makeCards(title: string, text: string): Promise<Card[]> {
		const pro = this.license.isPro();
		const types = allowedTypes(pro, { reversed: this.settings.useReversed, cloze: this.settings.useCloze });
		const max = cardCap(pro, this.settings.maxCards);
		const { system, user } = buildMessages(title, text, {
			maxCards: max,
			types,
			language: this.settings.language,
			extraInstructions: pro ? this.settings.extraInstructions : "",
		});
		const raw = await complete(obsidianHttp, this.modelConfig(), system, user);
		return parseCards(raw, types).slice(0, max);
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
		try {
			cards = await this.makeCards(file.basename, source);
		} catch (e) {
			notice.hide();
			this.busy = false;
			new Notice(e instanceof Error ? e.message : "Card generation failed.", 8000);
			return;
		}
		notice.hide();
		this.busy = false;
		if (!cards.length) {
			new Notice("The model did not return any usable cards. Try a longer section or another model.");
			return;
		}
		const write = (chosen: Card[]) => {
			const current = editor.getValue();
			const block = buildBlock(chosen, this.settings.deckTag, hashText(stripBlock(current)));
			const existing = findBlock(current);
			if (existing) {
				editor.replaceRange(block, editor.offsetToPos(existing.start), editor.offsetToPos(existing.end));
			} else {
				const end = editor.offsetToPos(current.length);
				const sep = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
				editor.replaceRange(`${sep}${block}\n`, end);
			}
			new Notice(chosen.length === 1 ? "Added 1 card." : `Added ${chosen.length} cards.`);
		};
		if (this.settings.reviewBeforeInsert) new ReviewModal(this.app, cards, file.basename, write).open();
		else write(cards);
	}

	private markdownIn(folder: TFolder): TFile[] {
		const prefix = folder.isRoot() ? "" : folder.path + "/";
		const exportDir = normalizePath(this.settings.exportFolder) + "/";
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(prefix) && !f.path.startsWith(exportDir));
	}

	/** Pro: generate for every note in a folder, skipping notes whose cards are up to date. */
	private async generateFolder(folder: TFolder): Promise<void> {
		if (this.busy) return;
		const files = this.markdownIn(folder);
		if (!files.length) {
			new Notice("No notes in that folder.");
			return;
		}
		this.busy = true;
		const notice = new Notice(`Cardsmith: 0 of ${files.length} notes`, 0);
		let made = 0;
		let skipped = 0;
		const failed: string[] = [];
		for (let i = 0; i < files.length; i++) {
			const file = files[i]!;
			notice.setMessage(`Cardsmith: ${i + 1} of ${files.length} notes (${file.basename})`);
			const content = await this.app.vault.cachedRead(file);
			const body = stripBlock(content);
			const hash = hashText(body);
			if (findBlock(content)?.hash === hash || body.trim().length < 80) {
				skipped++;
				continue;
			}
			try {
				const cards = await this.makeCards(file.basename, body);
				if (!cards.length) {
					skipped++;
					continue;
				}
				await this.app.vault.process(file, (data) => {
					const fresh = hashText(stripBlock(data));
					return upsertBlock(data, buildBlock(cards, this.settings.deckTag, fresh));
				});
				made += cards.length;
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
		new Notice(`Cardsmith made ${made} cards. ${skipped} notes were already up to date or too short.${tail}`, 10000);
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
		new Notice(`Exported ${all.length} cards to ${path}. In Anki, use File > Import.`, 8000);
	}
}
