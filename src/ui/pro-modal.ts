import { App, Modal, Setting } from "obsidian";
import { FREE_FOLDER_RUN_NOTES, PRO_FEATURES, type ProFeature } from "../core/features";
import { PRO_PAGE_URL } from "../config";

/** What the user was trying to do, said as an outcome. */
const PITCH: Record<ProFeature, { title: string; body: string }> = {
	batchFolder: {
		title: "Make cards for every note in a folder",
		body: "Pro runs Cardsmith on each note in the folder you pick, in one go. Notes whose cards are already up to date are skipped.",
	},
	refreshChanged: {
		title: "Refresh cards for notes you've changed",
		body: "Pro re-runs only the notes that changed since their cards were made. Cards that keep their question keep their Spaced Repetition review history.",
	},
	bulkExport: {
		title: "Export this folder to Anki",
		body: "Pro writes one Anki import file for a folder or the whole vault, with a deck for each folder. It runs offline.",
	},
	customInstructions: {
		title: "Tell the model how to write your cards",
		body: "Pro adds your own instructions to every request, for example exam style, level or language.",
	},
	moreCards: {
		title: "Make up to 50 cards from a note",
		body: "Free makes up to 10 cards per note. Pro raises that to 50.",
	},
};

/** Value-first upgrade screen, shown when a free user reaches a Pro feature. */
export class ProModal extends Modal {
	constructor(
		app: App,
		private feature: ProFeature,
		private salesOpen: boolean,
		private enterKey: () => void,
		/** Set when the one free folder run is still available. */
		private tryFree?: () => void,
	) {
		super(app);
	}
	onOpen(): void {
		const pitch = PITCH[this.feature];
		this.setTitle(pitch.title);
		const { contentEl } = this;
		contentEl.createEl("p", { text: pitch.body });
		const others = (Object.keys(PRO_FEATURES) as ProFeature[]).filter((f) => f !== this.feature);
		contentEl.createEl("p", { text: "Pro also includes:" });
		const ul = contentEl.createEl("ul");
		for (const f of others) ul.createEl("li", { text: PRO_FEATURES[f] });
		if (this.tryFree) {
			contentEl.createEl("p", { text: `Try it free on up to ${FREE_FOLDER_RUN_NOTES} notes first. This one run is free in each vault.` });
		}
		if (!this.salesOpen || !PRO_PAGE_URL) {
			contentEl.createEl("p", { cls: "cardsmith-muted", text: "Pro is not on sale yet." });
			const row = new Setting(contentEl);
			if (this.tryFree) row.addButton((b) => b.setButtonText(`Try on ${FREE_FOLDER_RUN_NOTES} notes`).setCta().onClick(() => { this.close(); this.tryFree?.(); }));
			row.addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
			return;
		}
		const price = contentEl.createEl("p");
		price.createEl("strong", { text: "$3/month, tax included." });
		price.appendText(" Cancel anytime, and your cards stay in your notes.");
		contentEl.createEl("p", { text: "First payment: full refund if you ask within 14 days. No questions asked." });
		contentEl.createEl("p", { cls: "cardsmith-muted", text: "Single notes stay free, with no license and no account." });
		const row = new Setting(contentEl).addButton((b) => b.setButtonText("I have a key").onClick(() => { this.close(); this.enterKey(); }));
		if (this.tryFree) row.addButton((b) => b.setButtonText(`Try on ${FREE_FOLDER_RUN_NOTES} notes`).onClick(() => { this.close(); this.tryFree?.(); }));
		row.addButton((b) => b.setButtonText("Subscribe: $3/month").setCta().onClick(() => window.open(PRO_PAGE_URL)));
	}
	onClose(): void {
		this.contentEl.empty();
	}
}
