import { App, Modal, Setting } from "obsidian";
import type { Card } from "../core/cards";

/** The cards the user kept: ticked, with a question (and an answer, unless cloze). */
export function chosenCards(cards: Card[], keep: boolean[]): Card[] {
	return cards.filter((c, i) => keep[i] && c.front.trim() && (c.type === "cloze" || c.back.trim()));
}

/** Editable card rows with a keep checkbox each. Shared by the single-note and the batch review windows. */
export function renderCards(parent: HTMLElement, cards: Card[], keep: boolean[], onChange: () => void): void {
	const list = parent.createDiv({ cls: "cardsmith-card-list" });
	cards.forEach((card, i) => {
		const row = list.createDiv({ cls: "cardsmith-card" });
		const head = row.createDiv({ cls: "cardsmith-card-head" });
		const cb = head.createEl("input", { type: "checkbox" });
		cb.checked = keep[i] ?? true;
		cb.addEventListener("change", () => {
			keep[i] = cb.checked;
			row.toggleClass("is-dropped", !cb.checked);
			onChange();
		});
		head.createSpan({ cls: `cardsmith-type cardsmith-type-${card.type}`, text: card.type });
		const front = row.createEl("textarea", { cls: "cardsmith-front" });
		front.value = card.front;
		front.rows = Math.min(4, Math.max(1, Math.ceil(card.front.length / 70)));
		front.addEventListener("input", () => {
			card.front = front.value;
			onChange();
		});
		if (card.type !== "cloze") {
			const back = row.createEl("textarea", { cls: "cardsmith-back" });
			back.value = card.back;
			back.rows = Math.min(4, Math.max(1, Math.ceil(card.back.length / 70)));
			back.addEventListener("input", () => {
				card.back = back.value;
				onChange();
			});
		}
	});
}

/** A bulleted list of card questions under a lead sentence; empties `el` when there are none. */
export function renderQuestions(el: HTMLElement, lead: string, questions: string[]): void {
	el.empty();
	if (!questions.length) return;
	el.createEl("p", { cls: "cardsmith-muted", text: lead });
	const ul = el.createEl("ul", { cls: "cardsmith-question-list" });
	for (const q of questions) ul.createEl("li", { text: q });
}

/** Lets the user edit, drop or keep each generated card before anything is written. */
export class ReviewModal extends Modal {
	private keep: boolean[];
	private done = false;
	private removedEl: HTMLElement | null = null;

	constructor(
		app: App,
		private cards: Card[],
		private noteName: string,
		private onAccept: (cards: Card[]) => void,
		/** Cards in the note's current block that have Spaced Repetition review history. */
		private withHistory = 0,
		/** Questions of the reviewed cards that inserting `chosen` would remove (with their history). */
		private removedFor?: (chosen: Card[]) => string[],
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
		renderCards(contentEl, this.cards, this.keep, () => this.update());
		this.removedEl = contentEl.createDiv({ cls: "cardsmith-removed" });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				this.button = b.buttonEl;
				b.setCta().onClick(() => {
					this.done = true;
					const chosen = chosenCards(this.cards, this.keep);
					this.close();
					if (chosen.length) this.onAccept(chosen);
				});
			});
		this.update();
	}

	private button: HTMLButtonElement | null = null;

	/** Questions of reviewed cards that would be removed by inserting the current selection. */
	removedQuestions(): string[] {
		return this.removedFor ? this.removedFor(chosenCards(this.cards, this.keep)) : [];
	}

	private update(): void {
		const n = this.keep.filter(Boolean).length;
		if (this.button) {
			this.button.setText(n === 1 ? "Insert 1 card" : `Insert ${n} cards`);
			this.button.disabled = n === 0;
		}
		if (this.removedEl) {
			const gone = this.removedQuestions();
			renderQuestions(
				this.removedEl,
				gone.length === 1
					? "This reviewed card is not in the new set. Inserting removes it and its review history:"
					: `These ${gone.length} reviewed cards are not in the new set. Inserting removes them and their review history:`,
				gone,
			);
		}
	}

	onClose(): void {
		this.contentEl.empty();
		void this.done;
	}
}
