/**
 * The quality bar, applied to a card draft before it reaches Anki: recall beats recognition,
 * passages aren't prompts, one idea per card, and logistics don't belong in spaced repetition.
 */

import { tokenise } from "./maths";
import { textLength } from "./render";

export type LintLevel = "warn" | "info";

export interface Lint {
	rule: string;
	level: LintLevel;
	message: string;
}

export interface LintInput {
	noteType: string;
	/** Authored markdown per field. */
	fields: Record<string, string>;
	/** Rendered HTML per field. */
	html: Record<string, string>;
	tags: string[];
}

const PASSAGE_CHARS = 350;

export function lintCard(c: LintInput): Lint[] {
	const out: Lint[] = [];
	const answerField = c.noteType === "Bridge Cloze" ? "Back Extra" : "Back";
	const answerLen = textLength(c.html[answerField] ?? "");
	if (answerLen > PASSAGE_CHARS) {
		out.push({
			rule: "passage",
			level: "warn",
			message: `The answer is ${answerLen} characters: that's a passage, not a prompt. Split it, or keep it in the note.`,
		});
	}
	const front = (c.fields.Front ?? c.fields.Text ?? "").trim();
	if (/^(what|define)\s+(is|are|does)?\b/i.test(front) && !/\b(not|instead|why|differ|versus|vs\.?)\b/i.test(front)) {
		out.push({
			rule: "define-not-discriminate",
			level: "info",
			message: "Definition prompts are weak. Can it ask \"why X and not Y\" instead?",
		});
	}
	if ((front.match(/\?/g) ?? []).length > 1) {
		out.push({ rule: "one-idea", level: "info", message: "More than one question on the front: one idea per card." });
	}
	if (/^\s*(\(?[a-e][).]|[A-E]\.)\s/m.test(front)) {
		out.push({
			rule: "recognition",
			level: "info",
			message: "This looks like multiple choice. Recall (type it, say it, cloze) builds memory better than recognising an option.",
		});
	}
	if (c.tags.some((t) => /^admin$|logistics/i.test(t))) {
		out.push({ rule: "logistics", level: "warn", message: "Logistics you look up once belong in the course note, not the deck." });
	}
	if (c.noteType === "Bridge Cloze" && !/\{\{c\d+::/.test(c.html.Text ?? "")) {
		out.push({ rule: "no-cloze", level: "warn", message: "A cloze card with no {{c1::…}} deletion will not produce a card." });
	}
	for (const [name, value] of Object.entries(c.fields)) {
		const { problems } = tokenise(value);
		if (problems.length) {
			out.push({
				rule: "ambiguous-dollar",
				level: "warn",
				message: `${name}: ${problems.length} dollar sign(s) were left as text, not maths. Check for a space just inside a $…$ pair, or escape a literal dollar as \\$.`,
			});
		}
	}
	return out;
}
