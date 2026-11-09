/**
 * The note types Anki Desk owns ("Bridge" because they bridge a note and its card). Every type carries two generated fields:
 * - `Context`: a breadcrumb (deck › heading), shown small above the question so a card is
 *   never orphaned from where it fits.
 * - `Source`: an obsidian:// link back to the note, shown on the answer side only, so a
 *   confusing card is one click from its context (D5) without cluttering the question.
 */

import type { NoteTypeSpec } from "./parse";

export interface BridgeModel {
	name: string;
	/** Fields the author writes. */
	authored: string[];
	isCloze: boolean;
	templates: { Name: string; Front: string; Back: string }[];
}

export const GENERATED_FIELDS = ["Context", "Source"] as const;

const SOURCE = `{{#Source}}<div class="bridge-src"><a href="{{Source}}">Open the note</a></div>{{/Source}}`;
const CONTEXT = `{{#Context}}<div class="bridge-ctx">{{Context}}</div>{{/Context}}`;

export const MODELS: BridgeModel[] = [
	{
		name: "Bridge Basic",
		authored: ["Front", "Back"],
		isCloze: false,
		templates: [
			{
				Name: "Card 1",
				Front: `${CONTEXT}\n<div class="bridge-q">{{Front}}</div>`,
				Back: `${CONTEXT}\n<div class="bridge-q">{{Front}}</div>\n<hr id="answer">\n<div class="bridge-a">{{Back}}</div>\n${SOURCE}`,
			},
		],
	},
	{
		name: "Bridge Cloze",
		authored: ["Text", "Back Extra"],
		isCloze: true,
		templates: [
			{
				Name: "Cloze",
				Front: `${CONTEXT}\n<div class="bridge-q">{{cloze:Text}}</div>`,
				Back: `${CONTEXT}\n<div class="bridge-q">{{cloze:Text}}</div>\n{{#Back Extra}}<div class="bridge-a">{{Back Extra}}</div>{{/Back Extra}}\n${SOURCE}`,
			},
		],
	},
	{
		name: "Bridge Type",
		authored: ["Front", "Back"],
		isCloze: false,
		templates: [
			{
				Name: "Card 1",
				Front: `${CONTEXT}\n<div class="bridge-q">{{Front}}</div>\n{{type:Back}}`,
				Back: `${CONTEXT}\n<div class="bridge-q">{{Front}}</div>\n<hr id="answer">\n{{type:Back}}\n${SOURCE}`,
			},
		],
	},
];

/**
 * Calm defaults: left-aligned, readable measure, generous line height, no animation, a muted
 * breadcrumb and source link, and night-mode colours from Anki's own variables.
 */
export const CSS = `.card {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Helvetica, Arial, sans-serif;
  font-size: 20px;
  line-height: 1.5;
  text-align: left;
  color: var(--fg, #1f2328);
  background-color: var(--canvas, #ffffff);
  max-width: 40em;
  margin: 0 auto;
  padding: 0 0.5em;
}
.bridge-ctx { font-size: 0.7em; color: var(--fg-subtle, #6e7781); margin-bottom: 0.75em; letter-spacing: 0.01em; }
.bridge-src { font-size: 0.7em; margin-top: 1.25em; }
.bridge-src a { color: var(--fg-subtle, #6e7781); }
.cloze { font-weight: 600; color: var(--accent-note, #0969da); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; background: var(--canvas-inset, #f6f8fa); padding: 0.1em 0.3em; border-radius: 4px; }
pre code { display: block; padding: 0.6em 0.8em; overflow-x: auto; }
img { max-width: 100%; height: auto; }
ul, ol { padding-left: 1.4em; }
hr#answer { border: none; border-top: 1px solid var(--border, #d0d7de); margin: 1em 0; }
`;

/** Names written in files by Obsidian_to_Anki → the Bridge type that replaces them. */
export const LEGACY_ALIASES: Record<string, string> = {
	Basic: "Bridge Basic",
	Cloze: "Bridge Cloze",
	"Basic (type in the answer)": "Bridge Type",
};

/** Field renames when converting legacy notes (legacy field → Bridge field). */
export const LEGACY_FIELD_MAP: Record<string, Record<string, string>> = {
	Basic: { Front: "Front", Back: "Back" },
	Cloze: { Text: "Text", "Back Extra": "Back Extra" },
	"Basic (type in the answer)": { Front: "Front", Back: "Back" },
};

export function modelByName(name: string): BridgeModel | undefined {
	return MODELS.find((m) => m.name === name);
}

/** Resolves a note type as written in a file to the Bridge model that will hold it. */
export function resolveWritten(written: string, extraAliases: Record<string, string> = {}): BridgeModel | null {
	const name = extraAliases[written] ?? LEGACY_ALIASES[written] ?? written;
	return modelByName(name) ?? null;
}

export function specResolver(extraAliases: Record<string, string> = {}): (written: string) => NoteTypeSpec | null {
	return (written) => {
		const m = resolveWritten(written, extraAliases);
		return m ? { fields: m.authored, isCloze: m.isCloze } : null;
	};
}

export function allFields(m: BridgeModel): string[] {
	return [...m.authored, ...GENERATED_FIELDS];
}
