import { App, FuzzySuggestModal, TFolder } from "obsidian";

export class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
	constructor(
		app: App,
		private onPick: (f: TFolder) => void,
	) {
		super(app);
		this.setPlaceholder("Pick a folder");
	}
	getItems(): TFolder[] {
		return this.app.vault.getAllFolders(true);
	}
	getItemText(f: TFolder): string {
		return f.isRoot() ? "/ (whole vault)" : f.path;
	}
	onChooseItem(f: TFolder): void {
		this.onPick(f);
	}
}
