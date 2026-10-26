/* Minimal stand-in for the "obsidian" module so plugin code can run under vitest. */
export const notices: string[] = [];
export class Notice {
	constructor(public message: string, _t?: number) { notices.push(message); }
	setMessage(m: string) { this.message = m; return this; }
	hide() {}
}
export const Platform = { isMobile: false, isDesktop: true };
export function normalizePath(p: string) { return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, ""); }
export const requestLog: unknown[] = [];
/** Tests can set `mockReply.fn` to answer requests (e.g. a fake local model). */
export const mockReply: { fn: ((req: any) => unknown) | null } = { fn: null };
export async function requestUrl(req: unknown) {
	requestLog.push(req);
	if (mockReply.fn) { const json = mockReply.fn(req); return { status: 200, json, text: JSON.stringify(json) }; }
	return { status: 599, json: null, text: "" };
}

export class TAbstractFile {}
export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	constructor(public path: string) { super(); }
	get name() { return this.path.split("/").pop() ?? ""; }
	isRoot() { return this.path === "" || this.path === "/"; }
}
export class TFile extends TAbstractFile {
	stat = { ctime: 0, mtime: 0, size: 0 };
	constructor(public path: string) { super(); }
	get basename() { return (this.path.split("/").pop() ?? "").replace(/\.md$/, ""); }
	get extension() { return this.path.split(".").pop() ?? ""; }
}
export class Component {}

/** Tiny stand-in for Obsidian's augmented HTMLElement: enough to render and click through modals. */
export class FakeEl {
	children: FakeEl[] = [];
	classes = new Set<string>();
	attrs: Record<string, string> = {};
	text = "";
	value = "";
	checked = false;
	disabled = false;
	rows = 1;
	type = "";
	shown = true;
	private listeners: Record<string, (() => void)[]> = {};
	constructor(public tag = "div", o: { cls?: string; text?: string; type?: string } = {}) {
		if (o.cls) for (const c of o.cls.split(" ")) this.classes.add(c);
		if (o.text) this.text = o.text;
		if (o.type) this.type = o.type;
	}
	createEl(tag: string, o: { cls?: string; text?: string; type?: string } = {}) { const e = new FakeEl(tag, o); this.children.push(e); return e; }
	createDiv(o: { cls?: string; text?: string } = {}) { return this.createEl("div", o); }
	createSpan(o: { cls?: string; text?: string } = {}) { return this.createEl("span", o); }
	empty() { this.children = []; this.text = ""; }
	setText(t: string) { this.text = t; }
	appendText(t: string) { this.text += t; }
	addClass(c: string) { this.classes.add(c); }
	toggleClass(c: string, on: boolean) { if (on) this.classes.add(c); else this.classes.delete(c); }
	hasClass(c: string) { return this.classes.has(c); }
	setAttr(k: string, v: string) { this.attrs[k] = v; }
	toggle(show: boolean) { this.shown = show; }
	addEventListener(type: string, fn: () => void) { (this.listeners[type] ??= []).push(fn); }
	fire(type: string) { for (const fn of this.listeners[type] ?? []) fn(); }
	click() { if (!this.disabled) this.fire("click"); }
	/** Every descendant, depth first. */
	all(): FakeEl[] { return this.children.flatMap((c) => [c, ...c.all()]); }
	find(pred: (e: FakeEl) => boolean) { return this.all().filter(pred); }
	allText(): string { return [this.text, ...this.children.map((c) => c.allText())].filter(Boolean).join("\n"); }
}

/** Every modal opened, newest last. */
export const openedModals: Modal[] = [];
export class Modal {
	contentEl = new FakeEl();
	modalEl = new FakeEl();
	title = "";
	isOpen = false;
	constructor(public app: unknown) {}
	open() { this.isOpen = true; openedModals.push(this); (this as unknown as { onOpen?: () => void }).onOpen?.(); }
	close() { if (!this.isOpen) return; this.isOpen = false; (this as unknown as { onClose?: () => void }).onClose?.(); }
	setTitle(t: string) { this.title = t; return this; }
}
export class FuzzySuggestModal<T> extends Modal {
	_t?: T;
	setPlaceholder() { return this; }
	// the real one renders a picker; tests call onChooseItem directly
	override open() { this.isOpen = true; openedModals.push(this); }
}
export class PluginSettingTab { containerEl = {}; constructor(public app: unknown, public plugin: unknown) {} }
export class ButtonComponent {
	buttonEl: FakeEl;
	constructor(parent: FakeEl) { this.buttonEl = parent.createEl("button"); }
	setButtonText(t: string) { this.buttonEl.setText(t); return this; }
	setCta() { this.buttonEl.addClass("mod-cta"); return this; }
	setDisabled(d: boolean) { this.buttonEl.disabled = d; return this; }
	onClick(fn: () => void) { this.buttonEl.addEventListener("click", fn); return this; }
}
export class Setting {
	settingEl: FakeEl;
	constructor(el: unknown) { this.settingEl = el instanceof FakeEl ? el.createDiv({ cls: "setting-item" }) : new FakeEl(); }
	setName() { return this; }
	setDesc() { return this; }
	setHeading() { return this; }
	addButton(cb: (b: ButtonComponent) => unknown) { cb(new ButtonComponent(this.settingEl)); return this; }
}
export class SecretComponent {}
export class MarkdownView {}

export class MockVault {
	files = new Map<string, string>();
	folders = new Set<string>();
	/** Folder tree for notes added with addNote (root is ""). */
	root = new TFolder("/");
	tree = new Map<string, TFolder>();
	fileObjs = new Map<string, TFile>();
	/** Paths read, in order, and how often the whole vault was listed. */
	reads: string[] = [];
	listCalls = 0;
	clock = 1000;
	getMarkdownFiles() { this.listCalls++; return [...this.files.keys()].filter((p) => p.endsWith(".md")).map((p) => new TFile(p)); }
	getFiles() { this.listCalls++; return [...this.files.keys()].map((p) => new TFile(p)); }
	getAllFolders() { return [...this.tree.values()]; }
	getRoot() { return this.root; }
	/** Add (or edit) a note inside the folder tree, with a modified time and size. */
	addNote(path: string, content: string, mtime = ++this.clock) {
		this.files.set(path, content);
		let f = this.fileObjs.get(path);
		if (!f) {
			f = new TFile(path);
			this.fileObjs.set(path, f);
			const parts = path.split("/");
			let parent = this.root;
			for (let i = 1; i < parts.length; i++) {
				const fp = parts.slice(0, i).join("/");
				let next = this.tree.get(fp);
				if (!next) { next = new TFolder(fp); this.tree.set(fp, next); parent.children.push(next); }
				parent = next;
			}
			parent.children.push(f);
		}
		f.stat = { ctime: 0, mtime, size: content.length };
		return f;
	}
	async cachedRead(f: TFile) { this.reads.push(f.path); return this.files.get(f.path) ?? ""; }
	async process(f: TFile, fn: (d: string) => string) {
		const v = fn(this.files.get(f.path) ?? "");
		this.files.set(f.path, v);
		const o = this.fileObjs.get(f.path);
		if (o) o.stat = { ctime: 0, mtime: ++this.clock, size: v.length };
		return v;
	}
	getFolderByPath(p: string) { return this.tree.get(p) ?? (this.folders.has(p) ? new TFolder(p) : null); }
	async createFolder(p: string) { this.folders.add(p); }
	getFileByPath(p: string) { return this.fileObjs.get(p) ?? (this.files.has(p) ? new TFile(p) : null); }
	async create(p: string, d: string) { this.files.set(p, d); return new TFile(p); }
	async modify(f: TFile, d: string) { this.files.set(f.path, d); }
}

export class Plugin {
	commands: { id: string; name: string; callback?: () => void; checkCallback?: (c: boolean) => boolean | void }[] = [];
	data: unknown = null;
	constructor(public app: any, public manifest: unknown) {}
	addCommand(c: any) { this.commands.push(c); return c; }
	addRibbonIcon() { return {}; }
	statusBar: FakeEl[] = [];
	addStatusBarItem() { const e = new FakeEl(); this.statusBar.push(e); return e; }
	addSettingTab() {}
	registerInterval(id: number) { return id; }
	async loadData() { return this.data; }
	async saveData(d: unknown) { this.data = JSON.parse(JSON.stringify(d)); }
}
