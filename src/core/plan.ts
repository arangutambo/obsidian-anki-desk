/**
 * Compares what the vault says each note should be with what Anki holds, and produces a plan.
 * Planning is pure; `execute` (sync.ts) applies it in batches and persists after each one.
 */

import type { AnkiNote } from "./anki";
import type { DesiredNote } from "./card";

export type PlanItem =
	| { kind: "create"; file: string; note: DesiredNote }
	| { kind: "convert"; file: string; note: DesiredNote; id: number; fromModel: string }
	| { kind: "update"; file: string; note: DesiredNote; id: number; fields: boolean; tags: boolean; deck: boolean }
	| { kind: "unchanged"; file: string; note: DesiredNote; id: number }
	| { kind: "missing"; file: string; note: DesiredNote; id: number }
	| { kind: "duplicate"; file: string; note: DesiredNote; id: number; firstFile: string };

export interface FileNotes {
	path: string;
	notes: DesiredNote[];
}

export interface PlanOptions {
	/** Re-create notes whose ID is in the file but gone from Anki (they get a new ID). */
	recreateMissing: boolean;
	/** Tags on the Anki side that sync must never remove. */
	keepTags: string[];
	/** Tags left by a previous tool that sync should drop (e.g. `Obsidian_to_Anki`). */
	dropTags: string[];
}

export interface Plan {
	items: PlanItem[];
	/** Notes Anki holds under the managed/legacy tag that no file references any more. */
	orphans: number[];
}

export function plan(
	files: FileNotes[],
	anki: Map<number, AnkiNote & { decks: string[] }>,
	managedIds: number[],
	opts: PlanOptions,
): Plan {
	const items: PlanItem[] = [];
	const seen = new Map<number, string>();
	for (const f of files) {
		for (const note of f.notes) {
			const id = note.block.id;
			if (id === null) {
				items.push({ kind: "create", file: f.path, note });
				continue;
			}
			const first = seen.get(id);
			if (first !== undefined) {
				items.push({ kind: "duplicate", file: f.path, note, id, firstFile: first });
				continue;
			}
			seen.set(id, f.path);
			const current = anki.get(id);
			if (!current) {
				items.push(opts.recreateMissing ? { kind: "create", file: f.path, note } : { kind: "missing", file: f.path, note, id });
				continue;
			}
			if (current.modelName !== note.model.name) {
				items.push({ kind: "convert", file: f.path, note, id, fromModel: current.modelName });
				continue;
			}
			const fields = Object.entries(note.fields).some(([k, v]) => (current.fields[k]?.value ?? "") !== v);
			const tags = !sameSet(finalTags(current.tags, note.tags, opts), current.tags);
			const deck = !(current.decks.length === 1 && current.decks[0] === note.deck);
			items.push(
				fields || tags || deck
					? { kind: "update", file: f.path, note, id, fields, tags, deck }
					: { kind: "unchanged", file: f.path, note, id },
			);
		}
	}
	const orphans = managedIds.filter((id) => !seen.has(id));
	return { items, orphans };
}

/** Desired tags, plus any Anki-side tags that must survive (leech, marked, bridge::*). */
export function finalTags(current: string[], desired: string[], opts: PlanOptions): string[] {
	const keep = current.filter(
		(t) => (opts.keepTags.includes(t) || t.startsWith("bridge::")) && !opts.dropTags.includes(t),
	);
	return [...new Set([...desired, ...keep])].filter((t) => !opts.dropTags.includes(t));
}

function sameSet(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const s = new Set(b);
	return a.every((x) => s.has(x));
}

export function summarise(p: Plan): Record<string, number> {
	const out: Record<string, number> = { create: 0, convert: 0, update: 0, unchanged: 0, missing: 0, duplicate: 0 };
	for (const it of p.items) out[it.kind]++;
	out.orphans = p.orphans.length;
	return out;
}
