/**
 * Card-field markdown → the HTML Anki stores.
 *
 * Order matters:
 * 1. Tokenise into text / code / maths, so nothing below can touch code or TeX.
 * 2. In cloze notes, `==highlight==` in text becomes the next cloze. The `==` must touch text
 *    on both sides, so Python's `a == b` is left alone.
 * 3. Wiki images become <img> (and are reported for upload); wiki links become their text.
 * 4. Maths is swapped for placeholders, markdown is rendered, then maths comes back as
 *    `\(…\)` / `\[…\]` with `}}` split so it can never close a cloze early.
 */

import { Marked } from "marked";

import { escapeHtml, tokenise, texForAnki, type MathsProblem } from "./maths";

export interface RenderOptions {
	cloze: boolean;
}

export interface MediaRef {
	/** Link target as written (`x.png`, `Assets/x.png`). */
	target: string;
	/** File name used inside Anki's media folder. */
	ankiName: string;
}

export interface Rendered {
	html: string;
	media: MediaRef[];
	problems: MathsProblem[];
}

const md = new Marked({ gfm: true, breaks: true, async: false });

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|avif|bmp)$/i;

export function renderField(source: string, opts: RenderOptions): Rendered {
	const { segments, problems } = tokenise(source);
	const media: MediaRef[] = [];
	const maths: string[] = [];
	let nextCloze = opts.cloze ? maxCloze(source) + 1 : 0;

	let assembled = "";
	for (const seg of segments) {
		if (seg.kind === "code") {
			assembled += seg.value;
		} else if (seg.kind === "math") {
			const tex = texForAnki(seg.tex.replace(/^\s+|\s+$/g, ""));
			maths.push(seg.display ? `\\[${tex}\\]` : `\\(${tex}\\)`);
			assembled += `\uE000${maths.length - 1}\uE001`;
		} else {
			let t = seg.value;
			if (opts.cloze) {
				t = t.replace(/==(?=\S)([^=\n]*?\S)==/g, (_m, inner: string) => `{{c${nextCloze++}::${inner}}}`);
			}
			t = t.replace(/!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g, (_m, target: string) => {
				const name = target.trim();
				if (!IMAGE_EXT.test(name)) return name;
				const ankiName = ankiMediaName(name);
				media.push({ target: name, ankiName });
				return `<img src="${escapeAttr(ankiName)}">`;
			});
			t = t.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, target: string, alias?: string) =>
				(alias ?? target).trim(),
			);
			assembled += t;
		}
	}

	let html = md.parse(assembled) as string;
	html = unwrapSingleParagraph(html.trim());
	html = html.replace(/\uE000(\d+)\uE001/g, (_m, k: string) => maths[Number(k)]);
	return { html, media, problems };
}

function maxCloze(s: string): number {
	let max = 0;
	for (const m of s.matchAll(/\{\{c(\d+)::/g)) max = Math.max(max, Number(m[1]));
	return max;
}

function unwrapSingleParagraph(html: string): string {
	const m = /^<p>([\s\S]*)<\/p>$/.exec(html);
	if (m && !m[1].includes("<p>")) return m[1];
	return html;
}

/** Anki's media folder is flat: keep the base name, which is what Obsidian links resolve to. */
export function ankiMediaName(target: string): string {
	const base = target.split("/").pop() ?? target;
	return base.replace(/[\\:*?"<>|]/g, "_");
}

function escapeAttr(s: string): string {
	return escapeHtml(s).replace(/"/g, "&quot;");
}

/** Plain-text length of rendered HTML, for the "this is a passage" lint. */
export function textLength(html: string): number {
	return html
		.replace(/<[^>]+>/g, "")
		.replace(/&[a-z]+;/g, " ")
		.replace(/\s+/g, " ")
		.trim().length;
}
