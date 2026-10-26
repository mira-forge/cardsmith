import type { CardType } from "./cards";

export interface PromptOptions {
	maxCards: number;
	types: CardType[];
	language: string; // "" = same language as the note
	extraInstructions: string; // Pro: custom instructions
}

export const MAX_INPUT_CHARS = 24000;

export function buildMessages(noteTitle: string, noteText: string, o: PromptOptions): { system: string; user: string; truncated: boolean } {
	const typeLines: string[] = [];
	if (o.types.includes("basic")) typeLines.push('- "basic": a question on "front" and a short answer on "back".');
	if (o.types.includes("reversed"))
		typeLines.push('- "reversed": a term on "front" and its definition on "back", useful both ways.');
	if (o.types.includes("cloze"))
		typeLines.push('- "cloze": one self-contained sentence on "front" with the hidden part wrapped in ==double equals==; leave "back" empty.');
	const lang = o.language.trim() ? `Write the cards in ${o.language.trim()}.` : "Write the cards in the same language as the note.";
	const system = [
		"You write high-quality spaced-repetition flashcards from a user's study notes.",
		"Rules: one fact per card; questions must make sense without seeing the note; answers short (ideally under 20 words);",
		"no trivia about formatting, headings or the note itself; never invent facts that are not in the note; skip anything ambiguous.",
		`Allowed card types:\n${typeLines.join("\n")}`,
		lang,
		`Return at most ${o.maxCards} cards, best first.`,
		'Reply with JSON only, exactly in this shape: {"cards":[{"type":"basic","front":"...","back":"..."}]}',
		o.extraInstructions.trim() ? `Additional instructions from the user:\n${o.extraInstructions.trim()}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
	const truncated = noteText.length > MAX_INPUT_CHARS;
	const text = truncated ? noteText.slice(0, MAX_INPUT_CHARS) + "\n[truncated]" : noteText;
	const user = `Note title: ${noteTitle}\n\nNote:\n"""\n${text}\n"""`;
	return { system, user, truncated };
}
