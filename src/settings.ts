import { App, PluginSettingTab, SecretComponent, Setting, type SettingDefinitionItem } from "obsidian";
import type CardsmithPlugin from "./main";
import { PRESETS, type ProviderKind } from "./ai/providers";
import { PRO_FEATURES } from "./core/features";
import { FREE_MAX_CARDS, PRO_MAX_CARDS, PRO_PAGE_URL } from "./config";
import type { StoredLicense } from "./license/types";
import type { SyncIndex } from "./core/sync";
import { FolderSuggestModal } from "./ui/folder-modal";

export interface CardsmithSettings {
	preset: string;
	kind: ProviderKind;
	baseUrl: string;
	model: string;
	/** Name of the entry in Obsidian's secret storage that holds the API key (not the key itself). */
	apiKeySecret: string;
	temperature: number;
	deckTag: string;
	maxCards: number;
	useReversed: boolean;
	useCloze: boolean;
	language: string;
	extraInstructions: string;
	reviewBeforeInsert: boolean;
	exportFolder: string;
	license: StoredLicense | null;
	/** Set once the one free folder run (up to 5 notes) has been used in this vault. */
	freeFolderRunUsed: boolean;
	/** Pro: folders Cardsmith keeps in sync ("/" is the whole vault). */
	syncedFolders: string[];
	/** Pro: per-note record (modified time, size, card state) so unchanged notes are not read again. */
	syncIndex: SyncIndex;
}

export const DEFAULT_SETTINGS: CardsmithSettings = {
	preset: "openai",
	kind: "openai",
	baseUrl: PRESETS.openai!.baseUrl,
	model: PRESETS.openai!.model,
	apiKeySecret: "",
	temperature: 0.2,
	deckTag: "#flashcards",
	maxCards: 8,
	useReversed: false,
	useCloze: false,
	language: "",
	extraInstructions: "",
	reviewBeforeInsert: true,
	exportFolder: "Cardsmith exports",
	license: null,
	freeFolderRunUsed: false,
	syncedFolders: [],
	syncIndex: {},
};

/**
 * One settings row. The same list drives both renderers:
 * - Obsidian 1.13+: getSettingDefinitions() returns these as declarative definitions, so every
 *   row (name, description and aliases) shows up in Obsidian's settings search.
 * - Obsidian 1.11.4 to 1.12.x: display() builds the same rows imperatively.
 */
interface Row {
	name: string;
	desc?: string;
	aliases?: string[];
	/** Adds the controls. May return the Setting (which is thenable), so the type is unknown, not void. */
	build: (setting: Setting) => unknown;
}

interface Section {
	heading?: string;
	rows: Row[];
}

export class CardsmithSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: CardsmithPlugin,
	) {
		super(app, plugin);
	}

	/**
	 * Re-render after a change that adds, removes or relabels rows. Feature-detects the
	 * 1.13+ update() (declarative re-render); older builds re-run the imperative renderer.
	 */
	private refresh(): void {
		const update = (this as { update?: () => void }).update;
		if (typeof update === "function") update.call(this);
		else this.renderLegacy();
	}

	/** Obsidian 1.13+: declarative definitions, indexed by the settings search. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return this.sections().map((sec) => ({
			type: "group" as const,
			heading: sec.heading,
			items: sec.rows.map((r) => ({
				name: r.name,
				desc: r.desc,
				aliases: r.aliases,
				render: (setting: Setting) => {
					setting.setName(r.name);
					if (r.desc) setting.setDesc(r.desc);
					r.build(setting);
				},
			})),
		}));
	}

	/** Fallback renderer for Obsidian before 1.13.0 (minAppVersion is 1.11.4). Not called on 1.13+. */
	display(): void {
		this.renderLegacy();
	}

	private renderLegacy(): void {
		const { containerEl } = this;
		containerEl.empty();
		for (const sec of this.sections()) {
			if (sec.heading) new Setting(containerEl).setName(sec.heading).setHeading();
			for (const r of sec.rows) {
				const setting = new Setting(containerEl).setName(r.name);
				if (r.desc) setting.setDesc(r.desc);
				r.build(setting);
			}
		}
	}

	private sections(): Section[] {
		const s = this.plugin.settings;
		const pro = this.plugin.license.isPro();
		const save = () => this.plugin.saveSettings();
		const cap = pro ? PRO_MAX_CARDS : FREE_MAX_CARDS;

		const provider: Row[] = [
			{
				name: "Model provider",
				desc: "Requests go directly from this device to the provider you pick. Cardsmith never sees your notes or keys.",
				aliases: ["AI", "OpenAI", "Anthropic", "Ollama", "local model", "LLM"],
				build: (st) =>
					st.addDropdown((d) => {
						for (const [id, p] of Object.entries(PRESETS)) d.addOption(id, p.label);
						d.setValue(s.preset).onChange(async (v) => {
							const p = PRESETS[v];
							if (!p) return;
							s.preset = v;
							s.kind = p.kind;
							s.baseUrl = p.baseUrl;
							s.model = p.model;
							await save();
							this.refresh();
						});
					}),
			},
		];
		if (s.kind !== "anthropic") {
			provider.push({
				name: "Base URL",
				desc: s.kind === "ollama" ? "Where Ollama is listening." : "OpenAI-compatible endpoint, ending in /v1 for most providers.",
				aliases: ["endpoint", "server", "host"],
				build: (st) =>
					st.addText((t) =>
						t.setValue(s.baseUrl).onChange(async (v) => {
							s.baseUrl = v.trim();
							await save();
						}),
					),
			});
		}
		provider.push({
			name: "Model",
			aliases: ["model name"],
			build: (st) =>
				st.addText((t) =>
					t.setValue(s.model).onChange(async (v) => {
						s.model = v.trim();
						await save();
					}),
				),
		});
		if (s.kind !== "ollama") {
			provider.push({
				name: "API key",
				desc: "Stored in Obsidian's secret storage on this device, not in your vault files.",
				aliases: ["token", "secret", "key"],
				build: (st) =>
					st.addComponent((el) =>
						new SecretComponent(this.app, el).setValue(s.apiKeySecret).onChange(async (v) => {
							s.apiKeySecret = v ?? "";
							await save();
						}),
					),
			});
		}

		const cards: Row[] = [
			{
				name: "Deck tag",
				desc: "Added above the cards so spaced repetition plugins pick them up.",
				aliases: ["tag", "spaced repetition", "flashcards"],
				build: (st) =>
					st.addText((t) =>
						t.setValue(s.deckTag).onChange(async (v) => {
							s.deckTag = v.trim() || "#flashcards";
							await save();
						}),
					),
			},
			{
				name: "Cards per note",
				desc: pro ? `Up to ${PRO_MAX_CARDS}.` : `Up to ${FREE_MAX_CARDS} on the free version, ${PRO_MAX_CARDS} with Pro.`,
				aliases: ["number of cards", "max cards", "limit"],
				build: (st) =>
					st.addSlider((sl) =>
						sl
							.setLimits(1, cap, 1)
							.setValue(Math.min(s.maxCards, cap))
							.onChange(async (v) => {
								s.maxCards = v;
								await save();
							}),
					),
			},
			{
				name: "Card language",
				desc: "Leave empty to match each note's language.",
				aliases: ["language", "translate"],
				build: (st) =>
					st.addText((t) =>
						t.setPlaceholder("Same as note").setValue(s.language).onChange(async (v) => {
							s.language = v;
							await save();
						}),
					),
			},
			{
				name: "Review cards before saving",
				desc: "Shows each card so you can edit or drop it before it is written to the note.",
				aliases: ["review", "preview", "confirm"],
				build: (st) =>
					st.addToggle((t) =>
						t.setValue(s.reviewBeforeInsert).onChange(async (v) => {
							s.reviewBeforeInsert = v;
							await save();
						}),
					),
			},
			{
				name: "Anki export folder",
				aliases: ["Anki", "export"],
				build: (st) =>
					st.addText((t) =>
						t.setValue(s.exportFolder).onChange(async (v) => {
							s.exportFolder = v.trim() || "Cardsmith exports";
							await save();
						}),
					),
			},
		];

		const toggle = (name: string, desc: string, aliases: string[], get: () => boolean, set: (v: boolean) => void): Row => ({
			name,
			desc,
			aliases,
			build: (st) =>
				st.addToggle((t) =>
					t.setValue(get()).onChange(async (v) => {
						set(v);
						await save();
					}),
				),
		});
		cards.splice(
			2,
			0,
			toggle("Reversed cards", "Term and definition cards you review both ways.", ["reverse", "both ways"], () => s.useReversed, (v) => (s.useReversed = v)),
			toggle("Cloze cards", "Fill-in-the-blank cards using ==highlights==.", ["cloze", "fill in the blank", "highlights"], () => s.useCloze, (v) => (s.useCloze = v)),
		);
		const proRows: Row[] = [
			{
				name: "Custom instructions",
				desc: pro ? "Extra guidance for the model, for example exam style or level." : "Requires Pro.",
				aliases: ["prompt", "instructions"],
				build: (st) =>
					st.addTextArea((t) => {
						t.setValue(s.extraInstructions).setDisabled(!pro);
						t.onChange(async (v) => {
							s.extraInstructions = v;
							await save();
						});
					}),
			},
		];

		proRows.push({
			name: "Synced folders",
			desc: pro
				? s.syncedFolders.length
					? "When Obsidian starts, Cardsmith counts the notes in these folders that changed since their cards were made or have no cards yet. Select the count in the status bar to review new cards for them. Nothing is saved until you approve it."
					: "Pick folders once. When Obsidian starts, Cardsmith counts the notes in them that changed since their cards were made or have no cards yet, and you refresh them in one reviewed batch."
				: "Requires Pro. Pick folders once; Cardsmith counts the notes in them with new content and refreshes them in one batch you review.",
			aliases: ["sync", "keep in sync", "changed notes", "refresh", "folder"],
			build: (st) =>
				st.addButton((b) =>
					b.setButtonText(pro ? "Add folder" : "See Pro").onClick(() => {
						if (!pro) {
							this.plugin.showPro("syncFolders", this.plugin.freeSyncRun());
							return;
						}
						new FolderSuggestModal(this.app, (f) => {
							void this.plugin.addSyncedFolder(f.isRoot() ? "/" : f.path).then(() => this.refresh());
						}).open();
					}),
				),
		});
		for (const path of s.syncedFolders) {
			proRows.push({
				name: path === "/" ? "/ (whole vault)" : path,
				desc:
					path !== "/" && !this.app.vault.getFolderByPath(path)
						? "Folder not found. It may have been renamed or deleted: remove it here and add it again."
						: pro
							? "Synced folder."
							: "Synced folder, paused without Pro.",
				build: (st) =>
					st.addButton((b) =>
						b.setButtonText("Remove").onClick(() => {
							void this.plugin.removeSyncedFolder(path).then(() => this.refresh());
						}),
					),
			});
		}

		return [
			{ rows: provider },
			{ heading: "Cards", rows: cards },
			{ heading: "Pro", rows: proRows },
			{ heading: "License", rows: this.licenseRows() },
		];
	}

	private licenseRows(): Row[] {
		const lic = this.plugin.license;
		const st = lic.getStatus();

		if (st.state === "pro" || st.state === "paused") {
			const desc =
				st.state === "paused"
					? "Pro is paused because the license could not be checked for over a week. Connect to the internet and select re-check. Free features keep working."
					: st.offline
						? "Pro is active. Working offline; the license will be re-checked when a connection is available."
						: st.expiresAt
							? `Pro is active. Current period ends ${new Date(st.expiresAt).toLocaleDateString()} and renews automatically unless cancelled.`
							: "Pro is active.";
			return [
				{
					name: st.state === "paused" ? "Pro paused" : "Pro active",
					desc,
					aliases: ["license", "subscription", "Pro"],
					build: (row) =>
						row
							.addButton((b) =>
								b.setButtonText("Re-check").onClick(async () => {
									await lic.revalidate(true);
									this.refresh();
								}),
							)
							.addButton((b) =>
								b.setButtonText("Remove license").onClick(async () => {
									await lic.remove();
									this.refresh();
								}),
							),
				},
			];
		}

		const rows: Row[] = [
			{
				name: "Cardsmith Pro",
				aliases: ["license", "subscription", "upgrade", "Pro"],
				build: (row) => {
					row.settingEl.addClass("cardsmith-pro-box");
					const box = row.descEl;
					box.empty();
					box.createEl("p", {
						text: lic.salesOpen() ? "Pro is $3/month, tax included. Cancel anytime; your cards stay in your notes. Pro adds:" : "Pro adds:",
					});
					const ul = box.createEl("ul");
					for (const f of Object.values(PRO_FEATURES)) ul.createEl("li", { text: f });
					if (st.message) box.createEl("p", { cls: "cardsmith-muted", text: st.message });
					box.createEl("p", {
						cls: "cardsmith-muted",
						text: lic.salesOpen()
							? "Activating sends only your license key and a random device id to the Cardsmith license service to check it, then once a day at most. Everything in the free version works without it."
							: "Pro is not on sale yet. All free features work without it.",
					});
				},
			},
		];
		if (!lic.salesOpen()) return rows;

		rows.push({
			name: "License key",
			aliases: ["activate", "license", "key"],
			build: (row) => {
				let entered = "";
				row.addText((t) => t.setPlaceholder("Paste your key").onChange((v) => (entered = v))).addButton((b) =>
					b
						.setButtonText("Activate")
						.setCta()
						.onClick(async () => {
							b.setDisabled(true);
							await this.plugin.activateLicense(entered);
							b.setDisabled(false);
							this.refresh();
						}),
				);
				if (PRO_PAGE_URL) row.addButton((b) => b.setButtonText("Get a license").onClick(() => window.open(PRO_PAGE_URL)));
			},
		});
		return rows;
	}
}
