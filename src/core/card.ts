/**
 * Turns a parsed block into the note Anki should hold: model, rendered fields (including the
 * generated Context and Source), deck and tags.
 */

import { hashObject } from "./hash";
import { resolveWritten, type BridgeModel } from "./models";
import type { CardBlock } from "./parse";
import { renderField, type MediaRef } from "./render";
import type { MathsProblem } from "./maths";

export interface CardContext {
	vaultName: string;
	/** Vault-relative path of the file, with `.md`. */
	path: string;
	/** Deck from frontmatter (`anki-deck`), overrides TARGET DECK. */
	frontmatterDeck: string | null;
	defaultDeck: string;
	fileTags: string[];
	/** Tag every managed note carries. */
	managedTag: string;
	aliases?: Record<string, string>;
}

export interface DesiredNote {
	block: CardBlock;
	model: BridgeModel;
	deck: string;
	fields: Record<string, string>;
	tags: string[];
	media: MediaRef[];
	problems: MathsProblem[];
	/** Hash of model + fields + deck + tags: unchanged hash ⇒ nothing to do. */
	hash: string;
}

export function desiredNote(block: CardBlock, ctx: CardContext): DesiredNote | null {
	const model = resolveWritten(block.noteType, ctx.aliases);
	if (!model) return null;
	const fields: Record<string, string> = {};
	const media: MediaRef[] = [];
	const problems: MathsProblem[] = [];
	for (const name of model.authored) {
		const r = renderField(block.fields[name] ?? "", { cloze: model.isCloze && name === model.authored[0] });
		fields[name] = r.html;
		media.push(...r.media);
		problems.push(...r.problems);
	}
	const deck = ctx.frontmatterDeck ?? block.deck ?? ctx.defaultDeck;
	fields.Context = contextLine(deck, block.heading);
	fields.Source = sourceUrl(ctx.vaultName, ctx.path);
	const tags = uniq([...ctx.fileTags, ...block.tags, ctx.managedTag]);
	const hash = hashObject({ m: model.name, f: fields, d: deck, t: [...tags].sort() });
	return { block, model, deck, fields, tags, media, problems, hash };
}

export function contextLine(deck: string, heading: string | null): string {
	const course = deck.split("::").pop() ?? deck;
	return heading ? `${escape(course)} › ${escape(heading)}` : escape(course);
}

export function sourceUrl(vaultName: string, path: string): string {
	const file = path.replace(/\.md$/, "");
	return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file)}`;
}

function escape(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function uniq<T>(xs: T[]): T[] {
	return [...new Set(xs)];
}
