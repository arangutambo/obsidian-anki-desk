/**
 * Splits card markdown into text, code and maths segments.
 *
 * The bug this exists to kill: Obsidian_to_Anki paired `$` signs with a regex, so `$p = $`
 * (a space before the closing dollar) was skipped and its dollars paired with the *next*
 * maths on the card, corrupting everything between. Here a dollar only opens maths if a
 * valid closer exists before any other `$`, and dollars inside code are never maths.
 *
 * Rules (pandoc's, made stricter):
 * - `\$` is a literal dollar.
 * - `$$…$$` is display maths when a closing `$$` exists.
 * - `$…$` is inline maths when the opener is followed by a non-space, the closer is preceded
 *   by a non-space and not followed by a digit, the content is non-empty, contains no other
 *   unescaped `$`, and does not cross a blank line.
 * - Anything else stays a literal `$` and is reported, so a lint can flag it.
 */

export type Segment =
	| { kind: "text"; value: string }
	| { kind: "code"; value: string }
	| { kind: "math"; display: boolean; tex: string };

export interface MathsProblem {
	kind: "unpaired-dollar";
	/** Offset of the dollar in the original string. */
	at: number;
}

export interface Tokenised {
	segments: Segment[];
	problems: MathsProblem[];
}

export function tokenise(src: string): Tokenised {
	const segments: Segment[] = [];
	const problems: MathsProblem[] = [];
	let text = "";
	const flushText = () => {
		if (text) segments.push({ kind: "text", value: text });
		text = "";
	};

	let i = 0;
	const n = src.length;
	while (i < n) {
		const ch = src[i];

		// Fenced code: ``` or ~~~ at the start of a line, through the matching fence.
		if ((ch === "`" || ch === "~") && atLineStart(src, i)) {
			const fence = /^(`{3,}|~{3,})/.exec(src.slice(i));
			if (fence) {
				const marker = fence[1];
				const close = findFenceClose(src, i + marker.length, marker);
				flushText();
				segments.push({ kind: "code", value: src.slice(i, close) });
				i = close;
				continue;
			}
		}

		// Inline code: a run of N backticks to the next run of exactly N backticks.
		if (ch === "`") {
			let run = 0;
			while (src[i + run] === "`") run++;
			const closeAt = findBacktickRun(src, i + run, run);
			if (closeAt >= 0) {
				flushText();
				segments.push({ kind: "code", value: src.slice(i, closeAt + run) });
				i = closeAt + run;
				continue;
			}
			text += src.slice(i, i + run);
			i += run;
			continue;
		}

		if (ch === "\\" && src[i + 1] === "$") {
			text += "\\$";
			i += 2;
			continue;
		}

		if (ch === "$") {
			if (src[i + 1] === "$") {
				const close = findDisplayClose(src, i + 2);
				if (close >= 0) {
					flushText();
					segments.push({ kind: "math", display: true, tex: src.slice(i + 2, close) });
					i = close + 2;
					continue;
				}
				problems.push({ kind: "unpaired-dollar", at: i });
				text += "$$";
				i += 2;
				continue;
			}
			const close = findInlineClose(src, i);
			if (close >= 0) {
				flushText();
				segments.push({ kind: "math", display: false, tex: src.slice(i + 1, close) });
				i = close + 1;
				continue;
			}
			problems.push({ kind: "unpaired-dollar", at: i });
			text += "$";
			i += 1;
			continue;
		}

		text += ch;
		i += 1;
	}
	flushText();
	return { segments, problems };
}

function atLineStart(src: string, i: number): boolean {
	let j = i - 1;
	while (j >= 0 && (src[j] === " " || src[j] === "\t")) j--;
	return j < 0 || src[j] === "\n";
}

function findFenceClose(src: string, from: number, marker: string): number {
	const re = new RegExp(`\\n[ \\t]*${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*(?=\\n|$)`, "g");
	re.lastIndex = from;
	const m = re.exec(src);
	return m ? m.index + m[0].length : src.length;
}

function findBacktickRun(src: string, from: number, run: number): number {
	let i = from;
	while (i < src.length) {
		if (src[i] === "`") {
			let r = 0;
			while (src[i + r] === "`") r++;
			if (r === run) return i;
			i += r;
			continue;
		}
		i++;
	}
	return -1;
}

function findDisplayClose(src: string, from: number): number {
	for (let i = from; i < src.length - 1; i++) {
		if (src[i] === "\\") {
			i++;
			continue;
		}
		if (src[i] === "$" && src[i + 1] === "$") return i > from ? i : -1;
	}
	return -1;
}

function findInlineClose(src: string, open: number): number {
	const after = src[open + 1];
	if (after === undefined || /\s/.test(after)) return -1;
	for (let i = open + 1; i < src.length; i++) {
		const c = src[i];
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === "\n" && src[i + 1] === "\n") return -1; // never cross a blank line
		if (c === "\n" && /^\s*\n/.test(src.slice(i + 1))) return -1;
		if (c === "$") {
			const before = src[i - 1];
			const next = src[i + 1];
			if (i === open + 1) return -1; // empty
			if (/\s/.test(before)) return -1; // `$p = $`: this dollar can't close, and maths can't contain `$`
			if (next !== undefined && /[0-9]/.test(next)) return -1;
			return i;
		}
	}
	return -1;
}

/** Maths content safe to embed in Anki HTML. Splits `}}` so it can't close a cloze early. */
export function texForAnki(tex: string): string {
	let t = tex;
	while (t.includes("}}")) t = t.replace(/\}\}/g, "} }");
	return escapeHtml(t);
}

export function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
