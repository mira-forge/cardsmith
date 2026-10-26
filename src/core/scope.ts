import { TFile, TFolder, normalizePath, type TAbstractFile } from "obsidian";

/**
 * Markdown notes inside one folder (and its subfolders), found by walking that folder's
 * own children. Nothing outside the chosen folder is listed or read, so Cardsmith never
 * enumerates the whole vault. Notes in `excludeDir` (the Anki export folder) are skipped.
 */
export function markdownUnder(folder: TFolder, excludeDir?: string): TFile[] {
	const skip = excludeDir ? normalizePath(excludeDir) : "";
	const out: TFile[] = [];
	const stack: TAbstractFile[] = [...folder.children];
	while (stack.length) {
		const item = stack.pop()!;
		if (item instanceof TFolder) {
			if (skip && (item.path === skip || item.path.startsWith(skip + "/"))) continue;
			stack.push(...item.children);
		} else if (item instanceof TFile && item.extension === "md") {
			out.push(item);
		}
	}
	return out.sort((a, b) => a.path.localeCompare(b.path));
}
