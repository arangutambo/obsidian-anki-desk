/**
 * Writes `<!--ID: n-->` markers back into a file without touching anything else.
 *
 * The caller passes the content it parsed; if the file changed since, nothing is written
 * (the next sync re-parses). Edits are applied from the end of the file backwards so earlier
 * offsets stay valid.
 */

import type { CardBlock } from "./parse";

export interface IdWrite {
	block: CardBlock;
	id: number;
}

const MARKER = /^<!--\s*ID:\s*\d+\s*-->[ \t]*\r?\n?/m;

export function applyIds(content: string, writes: IdWrite[]): string {
	const sorted = [...writes].sort((a, b) => b.block.start - a.block.start);
	let out = content;
	for (const { block, id } of sorted) {
		const marker = `<!--ID: ${id}-->`;
		const inner = out.slice(block.start, block.endLineStart);
		const m = MARKER.exec(inner);
		if (m) {
			const at = block.start + m.index;
			out = out.slice(0, at) + marker + "\n" + out.slice(at + m[0].length);
		} else {
			out = out.slice(0, block.endLineStart) + marker + "\n" + out.slice(block.endLineStart);
		}
	}
	return out;
}
