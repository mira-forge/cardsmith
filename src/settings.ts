import { App, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type CardsmithPlugin from "./main";
import { PRESETS, type ProviderKind } from "./ai/providers";
import { PRO_FEATURES } from "./core/features";
import { FREE_MAX_CARDS, LICENSE_RAIL, PRO_MAX_CARDS, PRO_PAGE_URL } from "./config";
import type { StoredLicense } from "./license/types";

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
};

export class CardsmithSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: CardsmithPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const pro = this.plugin.license.isPro();
		const save = () => this.plugin.saveSettings();

		new Setting(containerEl)
			.setName("Model provider")
			.setDesc("Requests go directly from this device to the provider you pick. Cardsmith never sees your notes or keys.")
			.addDropdown((d) => {
				for (const [id, p] of Object.entries(PRESETS)) d.addOption(id, p.label);
				d.setValue(s.preset).onChange(async (v) => {
					const p = PRESETS[v];
					if (!p) return;
					s.preset = v;
					s.kind = p.kind;
					s.baseUrl = p.baseUrl;
					s.model = p.model;
					await save();
					this.display();
				});
			});

		if (s.kind !== "anthropic") {
			new Setting(containerEl)
				.setName("Base URL")
				.setDesc(s.kind === "ollama" ? "Where Ollama is listening." : "OpenAI-compatible endpoint, ending in /v1 for most providers.")
				.addText((t) =>
					t.setValue(s.baseUrl).onChange(async (v) => {
						s.baseUrl = v.trim();
						await save();
					}),
				);
		}

		new Setting(containerEl).setName("Model").addText((t) =>
			t.setValue(s.model).onChange(async (v) => {
				s.model = v.trim();
				await save();
			}),
		);

		if (s.kind !== "ollama") {
			new Setting(containerEl)
				.setName("API key")
				.setDesc("Stored in Obsidian's secret storage on this device, not in your vault files.")
				.addComponent((el) =>
					new SecretComponent(this.app, el).setValue(s.apiKeySecret).onChange(async (v) => {
						s.apiKeySecret = v;
						await save();
					}),
				);
		}

		new Setting(containerEl).setName("Cards").setHeading();

		new Setting(containerEl)
			.setName("Deck tag")
			.setDesc("Added above the cards so spaced repetition plugins pick them up.")
			.addText((t) =>
				t.setValue(s.deckTag).onChange(async (v) => {
					s.deckTag = v.trim() || "#flashcards";
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Cards per note")
			.setDesc(pro ? `Up to ${PRO_MAX_CARDS}.` : `Up to ${FREE_MAX_CARDS} on the free version, ${PRO_MAX_CARDS} with Pro.`)
			.addSlider((sl) =>
				sl
					.setLimits(1, pro ? PRO_MAX_CARDS : FREE_MAX_CARDS, 1)
					.setValue(Math.min(s.maxCards, pro ? PRO_MAX_CARDS : FREE_MAX_CARDS))
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.maxCards = v;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Card language")
			.setDesc("Leave empty to match each note's language.")
			.addText((t) =>
				t.setPlaceholder("Same as note").setValue(s.language).onChange(async (v) => {
					s.language = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Review cards before saving")
			.setDesc("Shows each card so you can edit or drop it before it is written to the note.")
			.addToggle((t) =>
				t.setValue(s.reviewBeforeInsert).onChange(async (v) => {
					s.reviewBeforeInsert = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Anki export folder")
			.addText((t) =>
				t.setValue(s.exportFolder).onChange(async (v) => {
					s.exportFolder = v.trim() || "Cardsmith exports";
					await save();
				}),
			);

		new Setting(containerEl).setName("Pro").setHeading();

		const proToggle = (name: string, desc: string, get: () => boolean, set: (v: boolean) => void) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(pro ? desc : `${desc} Requires Pro.`)
				.addToggle((t) =>
					t
						.setValue(pro && get())
						.setDisabled(!pro)
						.onChange(async (v) => {
							set(v);
							await save();
						}),
				);
		proToggle("Reversed cards", "Term and definition cards you review both ways.", () => s.useReversed, (v) => (s.useReversed = v));
		proToggle("Cloze cards", "Fill-in-the-blank cards using ==highlights==.", () => s.useCloze, (v) => (s.useCloze = v));

		new Setting(containerEl)
			.setName("Custom instructions")
			.setDesc(pro ? "Extra guidance for the model, for example exam style or level." : "Requires Pro.")
			.addTextArea((t) => {
				t.setValue(s.extraInstructions).setDisabled(!pro);
				t.onChange(async (v) => {
					s.extraInstructions = v;
					await save();
				});
			});

		this.renderLicense(containerEl);
	}

	private renderLicense(containerEl: HTMLElement): void {
		const lic = this.plugin.license;
		const st = lic.getStatus();
		new Setting(containerEl).setName("License").setHeading();

		if (st.state === "pro" || st.state === "paused") {
			const desc =
				st.state === "paused"
					? "Pro is paused because the license could not be checked for over a week. Connect to the internet and select re-check. Free features keep working."
					: st.offline
						? "Pro is active. Working offline; the license will be re-checked when a connection is available."
						: st.expiresAt
							? `Pro is active. Current period ends ${new Date(st.expiresAt).toLocaleDateString()} and renews automatically unless cancelled.`
							: "Pro is active.";
			new Setting(containerEl)
				.setName(st.state === "paused" ? "Pro paused" : "Pro active")
				.setDesc(desc)
				.addButton((b) =>
					b.setButtonText("Re-check").onClick(async () => {
						await lic.revalidate(true);
						this.display();
					}),
				)
				.addButton((b) =>
					b.setButtonText("Remove license").onClick(async () => {
						await lic.remove();
						this.display();
					}),
				);
			return;
		}

		const box = containerEl.createDiv({ cls: "cardsmith-pro-box" });
		box.createEl("p", { text: "A Pro license unlocks:" });
		const ul = box.createEl("ul");
		for (const f of Object.values(PRO_FEATURES)) ul.createEl("li", { text: f });
		if (st.message) box.createEl("p", { cls: "cardsmith-muted", text: st.message });

		if (!lic.salesOpen()) {
			box.createEl("p", { cls: "cardsmith-muted", text: "Pro is not on sale yet. All free features work without it." });
			return;
		}
		box.createEl("p", {
			cls: "cardsmith-muted",
			text: `Activating sends only your license key${LICENSE_RAIL === "polar" ? " to Polar" : " and a random device id to the Cardsmith license service"} to check it, then once a day at most. Everything in the free version works without it.`,
		});

		let entered = "";
		const row = new Setting(containerEl)
			.setName("License key")
			.addText((t) => t.setPlaceholder("Paste your key").onChange((v) => (entered = v)))
			.addButton((b) =>
				b
					.setButtonText("Activate")
					.setCta()
					.onClick(async () => {
						b.setDisabled(true);
						await this.plugin.activateLicense(entered);
						b.setDisabled(false);
						this.display();
					}),
			);
		if (PRO_PAGE_URL) row.addButton((b) => b.setButtonText("Get a license").onClick(() => window.open(PRO_PAGE_URL)));
	}
}
