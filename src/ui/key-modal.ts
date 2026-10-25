import { App, Modal, Setting } from "obsidian";

export class KeyModal extends Modal {
	private value = "";
	constructor(
		app: App,
		private onSubmit: (key: string) => Promise<void>,
	) {
		super(app);
	}
	onOpen(): void {
		this.setTitle("Activate your license");
		this.contentEl.createEl("p", {
			cls: "cardsmith-muted",
			text: "Paste the key or the download page link from your itch.io purchase. Only the key is sent to the Mira Forge license server.",
		});
		new Setting(this.contentEl).setName("License key").addText((t) => {
			t.setPlaceholder("Key or itch.io download link").onChange((v) => (this.value = v));
			t.inputEl.addClass("cardsmith-key-input");
		});
		new Setting(this.contentEl).addButton((b) =>
			b.setButtonText("Activate").setCta().onClick(async () => {
				b.setDisabled(true);
				await this.onSubmit(this.value);
				this.close();
			}),
		);
	}
	onClose(): void {
		this.contentEl.empty();
	}
}
