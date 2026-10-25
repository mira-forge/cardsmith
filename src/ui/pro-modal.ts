import { App, Modal, Setting } from "obsidian";
import { PRO_FEATURES } from "../core/features";
import { PRO_PAGE_URL } from "../config";

export class ProModal extends Modal {
	constructor(
		app: App,
		private feature: string,
		private salesOpen: boolean,
		private enterKey: () => void,
	) {
		super(app);
	}
	onOpen(): void {
		this.setTitle("This needs a Pro license");
		const { contentEl } = this;
		contentEl.createEl("p", { text: `${this.feature} is a Pro feature.` });
		const ul = contentEl.createEl("ul");
		for (const f of Object.values(PRO_FEATURES)) ul.createEl("li", { text: f });
		contentEl.createEl("p", { cls: "cardsmith-muted", text: "Single-note generation and single-note Anki export stay free, with no license and no account." });
		if (!this.salesOpen || !PRO_PAGE_URL) {
			contentEl.createEl("p", { cls: "cardsmith-muted", text: "Pro is not on sale yet." });
			new Setting(contentEl).addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
			return;
		}
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("I have a key").onClick(() => { this.close(); this.enterKey(); }))
			.addButton((b) => b.setButtonText("Get a license").setCta().onClick(() => window.open(PRO_PAGE_URL)));
	}
	onClose(): void {
		this.contentEl.empty();
	}
}
