import { App, Modal, Setting } from "obsidian";
import type { Card } from "../core/cards";
import { plural } from "../core/features";
import { chosenCards, renderCards, renderQuestions } from "./review-modal";

/** One note in a synced-folder refresh, with the cards the model proposed. */
export interface SyncItem {
	path: string;
	name: string;
	/** "changed": text changed since its cards were made. "new": no cards yet. */
	reason: "changed" | "new";
	cards: Card[];
	/** What writing `chosen` would do to the note's reviewed cards (computed with the 0.1.5 merge). */
	preview: (chosen: Card[]) => { kept: number; stays: string[] };
}

/** What the user approved: one entry per included note, with the cards they kept. */
export interface SyncApproval {
	item: SyncItem;
	cards: Card[];
}

/**
 * One window for the whole batch. The user edits or unticks cards, or unticks a whole note.
 * Nothing is written until they select Approve; Cancel (or closing the window) writes nothing.
 */
export class SyncReviewModal extends Modal {
	private keep: boolean[][];
	private include: boolean[];
	private button: HTMLButtonElement | null = null;
	private historyEls: HTMLElement[] = [];
	private settled = false;

	constructor(
		app: App,
		private items: SyncItem[],
		private onApprove: (approved: SyncApproval[]) => void | Promise<void>,
		private onCancel: () => void,
		/** Extra lines shown at the top, e.g. notes that failed or returned no cards. */
		private notes: string[] = [],
	) {
		super(app);
		this.keep = items.map((it) => it.cards.map(() => true));
		this.include = items.map(() => true);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass("cardsmith-review");
		this.setTitle(`Refresh ${plural(this.items.length, "note")} with new content`);
		contentEl.createEl("p", {
			cls: "cardsmith-muted",
			text: "Edit anything that is off, untick cards you do not want, or untick a note to leave it as it is. Nothing is saved until you approve it.",
		});
		for (const line of this.notes) contentEl.createEl("p", { cls: "cardsmith-muted", text: line });
		this.items.forEach((item, n) => {
			const box = contentEl.createDiv({ cls: "cardsmith-sync-note" });
			const head = box.createDiv({ cls: "cardsmith-card-head" });
			const cb = head.createEl("input", { type: "checkbox" });
			cb.checked = true;
			cb.addEventListener("change", () => {
				this.include[n] = cb.checked;
				box.toggleClass("is-dropped", !cb.checked);
				this.update();
			});
			head.createEl("strong", { text: item.name });
			head.createSpan({ cls: "cardsmith-muted", text: item.reason === "new" ? "no cards yet" : "changed since its cards were made" });
			renderCards(box, item.cards, this.keep[n]!, () => this.update());
			this.historyEls[n] = box.createDiv({ cls: "cardsmith-removed" });
		});
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				this.button = b.buttonEl;
				b.setCta().onClick(() => void this.approve());
			});
		this.update();
	}

	/** The notes and cards that Approve would write. */
	approved(): SyncApproval[] {
		const out: SyncApproval[] = [];
		this.items.forEach((item, n) => {
			if (!this.include[n]) return;
			const cards = chosenCards(item.cards, this.keep[n]!);
			if (cards.length) out.push({ item, cards });
		});
		return out;
	}

	private async approve(): Promise<void> {
		const chosen = this.approved();
		if (!chosen.length) return;
		this.settled = true;
		this.close();
		await this.onApprove(chosen);
	}

	private update(): void {
		const notes = this.approved().length;
		if (this.button) {
			this.button.setText(notes === 1 ? "Approve 1 note" : `Approve ${notes} notes`);
			this.button.disabled = notes === 0;
		}
		this.items.forEach((item, n) => {
			const el = this.historyEls[n];
			if (!el) return;
			const cards = this.include[n] ? chosenCards(item.cards, this.keep[n]!) : [];
			if (!this.include[n] || !cards.length) {
				el.empty();
				return;
			}
			const { kept, stays } = item.preview(cards);
			renderQuestions(
				el,
				stays.length === 1
					? "This reviewed card is not in the new set. It stays at the end of the cards, with its review history:"
					: `These ${stays.length} reviewed cards are not in the new set. They stay at the end of the cards, with their review history:`,
				stays,
			);
			if (kept) el.createEl("p", { cls: "cardsmith-muted", text: `Keeps review history for ${plural(kept, "card")}.` });
		});
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.onCancel();
		}
	}
}
