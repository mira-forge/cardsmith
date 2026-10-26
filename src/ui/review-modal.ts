import { App, Modal, Setting } from "obsidian";
import type { Card } from "../core/cards";

/** Lets the user edit, drop or keep each generated card before anything is written. */
export class ReviewModal extends Modal {
	private keep: boolean[];
	private done = false;

	constructor(
		app: App,
		private cards: Card[],
		private noteName: string,
		private onAccept: (cards: Card[]) => void,
		/** Cards in the note's current block that have Spaced Repetition review history. */
		private withHistory = 0,
	) {
		super(app);
		this.keep = cards.map(() => true);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass("cardsmith-review");
		this.setTitle(`${this.cards.length} ${this.cards.length === 1 ? "card" : "cards"} from ${this.noteName}`);
		contentEl.createEl("p", {
			cls: "cardsmith-muted",
			text: "Edit anything that is off and untick cards you do not want. Nothing is saved until you insert.",
		});
		if (this.withHistory > 0) {
			contentEl.createEl("p", {
				cls: "cardsmith-muted",
				text: `${this.withHistory === 1 ? "1 card" : `${this.withHistory} cards`} in this note ${this.withHistory === 1 ? "has" : "have"} review history from Spaced Repetition. A card with the same question keeps it. Cards that are not in the new set lose it.`,
			});
		}
		const list = contentEl.createDiv({ cls: "cardsmith-card-list" });
		this.cards.forEach((card, i) => {
			const row = list.createDiv({ cls: "cardsmith-card" });
			const head = row.createDiv({ cls: "cardsmith-card-head" });
			const cb = head.createEl("input", { type: "checkbox" });
			cb.checked = true;
			cb.addEventListener("change", () => {
				this.keep[i] = cb.checked;
				row.toggleClass("is-dropped", !cb.checked);
				this.updateButton();
			});
			head.createSpan({ cls: `cardsmith-type cardsmith-type-${card.type}`, text: card.type });
			const front = row.createEl("textarea", { cls: "cardsmith-front" });
			front.value = card.front;
			front.rows = Math.min(4, Math.max(1, Math.ceil(card.front.length / 70)));
			front.addEventListener("input", () => (card.front = front.value));
			if (card.type !== "cloze") {
				const back = row.createEl("textarea", { cls: "cardsmith-back" });
				back.value = card.back;
				back.rows = Math.min(4, Math.max(1, Math.ceil(card.back.length / 70)));
				back.addEventListener("input", () => (card.back = back.value));
			}
		});
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				this.button = b.buttonEl;
				b.setCta().onClick(() => {
					this.done = true;
					const chosen = this.cards.filter((c, i) => this.keep[i] && c.front.trim() && (c.type === "cloze" || c.back.trim()));
					this.close();
					if (chosen.length) this.onAccept(chosen);
				});
			});
		this.updateButton();
	}

	private button: HTMLButtonElement | null = null;

	private updateButton(): void {
		const n = this.keep.filter(Boolean).length;
		if (this.button) {
			this.button.setText(n === 1 ? "Insert 1 card" : `Insert ${n} cards`);
			this.button.disabled = n === 0;
		}
	}

	onClose(): void {
		this.contentEl.empty();
		void this.done;
	}
}
