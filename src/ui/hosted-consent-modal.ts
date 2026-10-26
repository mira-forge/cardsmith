import { App, Modal, Setting } from "obsidian";
import { HOSTED_CONSENT } from "../ai/hosted";

/** One-time consent before the first hosted request. Resolves true only when the user accepts. */
export class HostedConsentModal extends Modal {
	private decided = false;
	constructor(
		app: App,
		private onDecide: (accepted: boolean) => void,
	) {
		super(app);
	}
	onOpen(): void {
		this.setTitle(HOSTED_CONSENT.title);
		const { contentEl } = this;
		contentEl.createEl("p", { text: HOSTED_CONSENT.intro });
		const ul = contentEl.createEl("ul");
		for (const item of HOSTED_CONSENT.items) ul.createEl("li", { text: item });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText(HOSTED_CONSENT.cancel).onClick(() => this.decide(false)))
			.addButton((b) => b.setButtonText(HOSTED_CONSENT.accept).setCta().onClick(() => this.decide(true)));
	}
	private decide(accepted: boolean): void {
		if (this.decided) return;
		this.decided = true;
		this.onDecide(accepted);
		this.close();
	}
	onClose(): void {
		this.contentEl.empty();
		// closing with Escape or the X counts as "no"
		if (!this.decided) {
			this.decided = true;
			this.onDecide(false);
		}
	}
}

export function askHostedConsent(app: App): Promise<boolean> {
	return new Promise((resolve) => new HostedConsentModal(app, resolve).open());
}
