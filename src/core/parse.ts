/**
 * Reads card blocks out of a markdown file, in Obsidian_to_Anki's syntax:
 *
 *     TARGET DECK: Biology::Cells
 *     START
 *     Basic
 *     Front: question (may span lines)
 *     Back: answer
 *     Tags: theme1::probability sheet
 *     <!--ID: 1793621663610-->
 *     END
 *
 * Positions are kept so ID markers can be written back without touching anything else.
 * `START` lines inside fenced code (e.g. a note documenting the syntax) are ignored.
 */

export interface NoteTypeSpec {
	/** Fields the author writes, in order. */
	fields: string[];
	isCloze: boolean;
}

export interface CardBlock {
	/** 0-based order of the block in the file. */
	index: number;
	/** 1-based line number of the START line. */
	line: number;
	/** Offset of the first character of the START line. */
	start: number;
	/** Offset of the first character of the END line (IDs are inserted here). */
	endLineStart: number;
	/** Offset just past the END line. */
	end: number;
	/** Note type exactly as written. */
	noteType: string;
	fields: Record<string, string>;
	tags: string[];
	id: number | null;
	/** TARGET DECK in effect at this block, if any. */
	deck: string | null;
	/** Nearest heading above the block. */
	heading: string | null;
}

export interface ParseProblem {
	line: number;
	kind: "unknown-note-type" | "unterminated-block" | "duplicate-id" | "empty-block";
	detail: string;
}

export interface ParsedFile {
	blocks: CardBlock[];
	fileTags: string[];
	problems: ParseProblem[];
}

export type NoteTypeResolver = (written: string) => NoteTypeSpec | null;

interface Line {
	text: string;
	start: number;
	no: number;
}

function splitLines(src: string): Line[] {
	const out: Line[] = [];
	let start = 0;
	let no = 1;
	for (let i = 0; i <= src.length; i++) {
		if (i === src.length || src[i] === "\n") {
			out.push({ text: src.slice(start, i).replace(/\r$/, ""), start, no });
			start = i + 1;
			no++;
		}
	}
	return out;
}

const TARGET_DECK = /^TARGET DECK:?\s*(.*)$/;
const FILE_TAGS = /^FILE TAGS:?\s*(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ID_LINE = /^<!--\s*ID:\s*(\d+)\s*-->\s*$/;
const TAGS_LINE = /^Tags:\s*(.*)$/;
const FENCE = /^\s*(`{3,}|~{3,})/;

export function parseCards(src: string, resolve: NoteTypeResolver): ParsedFile {
	const lines = splitLines(src);
	const blocks: CardBlock[] = [];
	const problems: ParseProblem[] = [];
	let fileTags: string[] = [];
	let deck: string | null = null;
	let heading: string | null = null;
	let fence: string | null = null;
	const seenIds = new Map<number, number>();

	for (let li = 0; li < lines.length; li++) {
		const { text } = lines[li];

		const f = FENCE.exec(text);
		if (fence) {
			if (f && f[1][0] === fence[0] && f[1].length >= fence.length && text.trim() === f[1]) fence = null;
			continue;
		}
		if (f) {
			fence = f[1];
			continue;
		}

		const h = HEADING.exec(text);
		if (h) {
			heading = h[2].trim() || null;
			continue;
		}
		const td = TARGET_DECK.exec(text);
		if (td) {
			let name = td[1].trim();
			if (!name && li + 1 < lines.length) {
				name = lines[li + 1].text.trim();
				li++;
			}
			deck = name || null;
			continue;
		}
		const ft = FILE_TAGS.exec(text);
		if (ft) {
			fileTags = splitTags(ft[1]);
			continue;
		}
		if (text.trim() !== "START") continue;

		// Inside a block until a line that is exactly END.
		const startLine = lines[li];
		let lj = li + 1;
		while (lj < lines.length && lines[lj].text.trim() !== "END") lj++;
		if (lj >= lines.length) {
			problems.push({ line: startLine.no, kind: "unterminated-block", detail: "START without END" });
			break;
		}
		const body = lines.slice(li + 1, lj);
		const endLine = lines[lj];
		li = lj;

		const typeIdx = body.findIndex((l) => l.text.trim() !== "");
		if (typeIdx < 0) {
			problems.push({ line: startLine.no, kind: "empty-block", detail: "no note type" });
			continue;
		}
		const noteType = body[typeIdx].text.trim();
		const spec = resolve(noteType);
		if (!spec) {
			problems.push({ line: startLine.no, kind: "unknown-note-type", detail: noteType });
			continue;
		}

		const fields: Record<string, string> = {};
		const fieldRe = new RegExp(`^(${spec.fields.map(escapeRe).join("|")}):\\s?(.*)$`);
		let current: string | null = null;
		const buf: Record<string, string[]> = {};
		let tags: string[] = [];
		let id: number | null = null;
		for (const l of body.slice(typeIdx + 1)) {
			const idm = ID_LINE.exec(l.text.trim());
			if (idm) {
				id = Number(idm[1]);
				continue;
			}
			const tm = TAGS_LINE.exec(l.text);
			if (tm) {
				tags = splitTags(tm[1]);
				current = null;
				continue;
			}
			const fm = fieldRe.exec(l.text);
			if (fm) {
				current = fm[1];
				buf[current] = [fm[2]];
				continue;
			}
			if (current === null) {
				// Text before any field label belongs to the first field (Obsidian_to_Anki allows this).
				if (l.text.trim() === "" && !buf[spec.fields[0]]) continue;
				current = spec.fields[0];
				buf[current] = buf[current] ?? [];
			}
			buf[current].push(l.text);
		}
		for (const name of spec.fields) fields[name] = (buf[name] ?? []).join("\n").replace(/\s+$/, "").replace(/^\n+/, "");

		if (id !== null) {
			const prev = seenIds.get(id);
			if (prev !== undefined) {
				problems.push({ line: startLine.no, kind: "duplicate-id", detail: `ID ${id} also at line ${prev}` });
			} else {
				seenIds.set(id, startLine.no);
			}
		}

		blocks.push({
			index: blocks.length,
			line: startLine.no,
			start: startLine.start,
			endLineStart: endLine.start,
			end: endLine.start + endLine.text.length,
			noteType,
			fields,
			tags,
			id,
			deck,
			heading,
		});
	}
	return { blocks, fileTags, problems };
}

export function splitTags(s: string): string[] {
	return s
		.split(/[\s,]+/)
		.map((t) => t.trim())
		.filter(Boolean);
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Serialises a card back into block syntax (used by templates). */
export function formatBlock(noteType: string, fieldOrder: string[], fields: Record<string, string>, tags: string[]): string {
	const out = ["START", noteType];
	for (const name of fieldOrder) {
		const value = (fields[name] ?? "").replace(/\s+$/, "");
		out.push(`${name}: ${value}`);
	}
	if (tags.length) out.push(`Tags: ${tags.join(" ")}`);
	out.push("END");
	return out.join("\n");
}
