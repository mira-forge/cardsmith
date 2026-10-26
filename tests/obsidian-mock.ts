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
	constructor(public path: string) { super(); }
	get basename() { return (this.path.split("/").pop() ?? "").replace(/\.md$/, ""); }
	get extension() { return this.path.split(".").pop() ?? ""; }
}
export class Component {}
export class Modal {
	contentEl = { empty() {}, createEl() { return {}; }, createDiv() { return {}; } };
	constructor(public app: unknown) {}
	open() {} close() {} setTitle() { return this; }
}
export class FuzzySuggestModal<T> extends Modal { _t?: T; }
export class PluginSettingTab { containerEl = {}; constructor(public app: unknown, public plugin: unknown) {} }
export class Setting { constructor(_el: unknown) {} }
export class SecretComponent {}
export class MarkdownView {}

export class MockVault {
	files = new Map<string, string>();
	folders = new Set<string>();
	getMarkdownFiles() { return [...this.files.keys()].filter((p) => p.endsWith(".md")).map((p) => new TFile(p)); }
	async cachedRead(f: TFile) { return this.files.get(f.path) ?? ""; }
	async process(f: TFile, fn: (d: string) => string) { const v = fn(this.files.get(f.path) ?? ""); this.files.set(f.path, v); return v; }
	getFolderByPath(p: string) { return this.folders.has(p) ? new TFolder(p) : null; }
	async createFolder(p: string) { this.folders.add(p); }
	getFileByPath(p: string) { return this.files.has(p) ? new TFile(p) : null; }
	async create(p: string, d: string) { this.files.set(p, d); return new TFile(p); }
	async modify(f: TFile, d: string) { this.files.set(f.path, d); }
}

export class Plugin {
	commands: { id: string; name: string; callback?: () => void; checkCallback?: (c: boolean) => boolean | void }[] = [];
	data: unknown = null;
	constructor(public app: any, public manifest: unknown) {}
	addCommand(c: any) { this.commands.push(c); return c; }
	addRibbonIcon() { return {}; }
	addSettingTab() {}
	registerInterval(id: number) { return id; }
	async loadData() { return this.data; }
	async saveData(d: unknown) { this.data = JSON.parse(JSON.stringify(d)); }
}
