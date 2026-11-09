/**
 * Card templates as commands. Each template turns a selection (plus where it sits) into a
 * card draft. Built-ins ship in code; the vault can add or replace templates with fenced
 * `anki-template` blocks in one note (path in settings):
 *
 * ```anki-template
 * id: drug
 * label: Drug card
 * type: Bridge Basic
 * Front: {{selection.firstLine}}: mechanism, key adverse effects, one interaction?
 * Back: {{selection.rest}}
 * tags: pharm
 * ```
 *
 * Placeholders: {{selection}}, {{selection.firstLine}}, {{selection.rest}}, {{heading}},
 * {{note}}, {{deck}}. Field values may span lines; a line that starts with another field's
 * name (or `tags:`) ends the previous one.
 */

import { modelByName } from "./models";

export interface TemplateContext {
	selection: string;
	heading: string | null;
	note: string;
	deck: string;
}

export interface CardDraft {
	noteType: string;
	fields: Record<string, string>;
	tags: string[];
}

export interface Template {
	id: string;
	label: string;
	noteType: string;
	description: string;
	/** "builtin" or the vault path it came from. */
	origin: string;
	make(ctx: TemplateContext): CardDraft;
}

function lines(s: string): { first: string; rest: string } {
	const t = s.trim();
	const nl = t.indexOf("\n");
	return nl < 0 ? { first: t, rest: "" } : { first: t.slice(0, nl).trim(), rest: t.slice(nl + 1).trim() };
}

function stripListMarker(s: string): string {
	return s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
}

export const BUILTINS: Template[] = [
	{
		id: "basic",
		label: "Basic",
		noteType: "Bridge Basic",
		description: "First line becomes the question, the rest the answer.",
		origin: "builtin",
		make: (c) => {
			const { first, rest } = lines(c.selection);
			return { noteType: "Bridge Basic", fields: { Front: first, Back: rest }, tags: [] };
		},
	},
	{
		id: "cloze",
		label: "Cloze",
		noteType: "Bridge Cloze",
		description: "==Highlights== become deletions; with none, the whole selection is one deletion.",
		origin: "builtin",
		make: (c) => {
			const sel = c.selection.trim();
			const text = /==(?=\S)[^=\n]*?\S==/.test(sel) || /\{\{c\d+::/.test(sel) ? sel : `{{c1::${sel}}}`;
			return { noteType: "Bridge Cloze", fields: { Text: text, "Back Extra": "" }, tags: [] };
		},
	},
	{
		id: "sequence",
		label: "Sequence (one deletion per step)",
		noteType: "Bridge Cloze",
		description: "Each list item becomes its own deletion: pathways, mechanisms, steps.",
		origin: "builtin",
		make: (c) => {
			const items = c.selection
				.split("\n")
				.map((l) => l.trimEnd())
				.filter((l) => l.trim());
			const intro = c.heading ? `${c.heading}:\n` : "";
			let k = 0;
			const body = items
				.map((l) => (/^\s*(?:[-*+]|\d+[.)])\s+/.test(l) ? l.replace(stripListMarker(l), `{{c${++k}::${stripListMarker(l)}}}`) : l))
				.join("\n");
			return { noteType: "Bridge Cloze", fields: { Text: intro + body, "Back Extra": "" }, tags: [] };
		},
	},
	{
		id: "pair",
		label: "Discriminating pair",
		noteType: "Bridge Basic",
		description: "\"Why X and not Y?\" Discriminate, don't define.",
		origin: "builtin",
		make: (c) => {
			const { first, rest } = lines(c.selection);
			const [x, y] = first.split(/\s+(?:vs\.?|versus|and)\s+/i);
			const front = y ? `When would you choose ${x.trim()} rather than ${y.trim()}, and why?` : `Why ${first} and not …? (name the alternative)`;
			return { noteType: "Bridge Basic", fields: { Front: front, Back: rest }, tags: [] };
		},
	},
	{
		id: "predict",
		label: "Predict the output",
		noteType: "Bridge Type",
		description: "Code on the front, type what it produces.",
		origin: "builtin",
		make: (c) => {
			const sel = c.selection.trim();
			const code = sel.startsWith("```") ? sel : "```\n" + sel + "\n```";
			return { noteType: "Bridge Type", fields: { Front: `Predict the output\n${code}`, Back: "" }, tags: [] };
		},
	},
	{
		id: "explain",
		label: "Explain it (whole-topic recall)",
		noteType: "Bridge Basic",
		description: "Recall a whole section in your own words, then check.",
		origin: "builtin",
		make: (c) => {
			const topic = c.heading ?? c.note;
			return {
				noteType: "Bridge Basic",
				fields: { Front: `Explain **${topic}** in your own words, start to finish. Then check.`, Back: c.selection.trim() },
				tags: ["explain"],
			};
		},
	},
];

/** Parses `anki-template` blocks out of a note. Invalid blocks are reported, not thrown. */
export function parseTemplates(content: string, origin: string): { templates: Template[]; errors: string[] } {
	const templates: Template[] = [];
	const errors: string[] = [];
	const re = /```anki-template\s*\n([\s\S]*?)\n```/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content))) {
		const spec = m[1];
		const meta: Record<string, string> = {};
		const fieldsRaw: Record<string, string[]> = {};
		const typeLine = /^type:\s*(.+)$/m.exec(spec);
		const noteType = typeLine?.[1].trim() ?? "Bridge Basic";
		const model = modelByName(noteType);
		if (!model) {
			errors.push(`${origin}: unknown type "${noteType}"`);
			continue;
		}
		let current: string | null = null;
		for (const line of spec.split("\n")) {
			const meta1 = /^(id|label|type|tags|description):\s*(.*)$/.exec(line);
			if (meta1) {
				meta[meta1[1]] = meta1[2].trim();
				current = null;
				continue;
			}
			const f = new RegExp(`^(${model.authored.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}):\\s?(.*)$`).exec(line);
			if (f) {
				current = f[1];
				fieldsRaw[current] = [f[2]];
				continue;
			}
			if (current) fieldsRaw[current].push(line);
		}
		if (!meta.id) {
			errors.push(`${origin}: a template has no id`);
			continue;
		}
		const fieldSpecs = Object.fromEntries(Object.entries(fieldsRaw).map(([k, v]) => [k, v.join("\n").trim()]));
		const tags = (meta.tags ?? "").split(/[\s,]+/).filter(Boolean);
		templates.push({
			id: meta.id,
			label: meta.label ?? meta.id,
			noteType,
			description: meta.description ?? `From ${origin}`,
			origin,
			make: (c) => ({
				noteType,
				fields: Object.fromEntries(model.authored.map((name) => [name, fill(fieldSpecs[name] ?? "", c)])),
				tags,
			}),
		});
	}
	return { templates, errors };
}

export function fill(spec: string, c: TemplateContext): string {
	const { first, rest } = lines(c.selection);
	const values: Record<string, string> = {
		selection: c.selection.trim(),
		"selection.firstLine": first,
		"selection.rest": rest,
		heading: c.heading ?? c.note,
		note: c.note,
		deck: c.deck,
	};
	return spec.replace(/\{\{\s*(selection(?:\.firstLine|\.rest)?|heading|note|deck)\s*\}\}/g, (_m, k: string) => values[k] ?? "");
}

/** Built-ins, overridden or extended by vault templates with the same or new ids. */
export function mergeTemplates(builtins: Template[], vault: Template[], disabled: string[]): Template[] {
	const byId = new Map<string, Template>();
	for (const t of builtins) byId.set(t.id, t);
	for (const t of vault) byId.set(t.id, t);
	return [...byId.values()].filter((t) => !disabled.includes(t.id));
}
