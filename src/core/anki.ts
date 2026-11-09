/**
 * AnkiConnect client over an injected transport, so the same code runs in Obsidian
 * (`requestUrl`), in Node (the CLI) and in tests (a fake).
 */

export type Transport = (body: string) => Promise<string>;

export interface Action {
	action: string;
	params?: Record<string, unknown>;
}

export class AnkiError extends Error {}

export class Anki {
	constructor(private readonly send: Transport) {}

	async call<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
		const raw = await this.send(JSON.stringify({ action, version: 6, params }));
		const r = JSON.parse(raw) as { result: T; error: string | null };
		if (r.error) throw new AnkiError(`${action}: ${r.error}`);
		return r.result;
	}

	/**
	 * Runs actions through `multi` in batches. Each element of the result is the action's own
	 * result, or an AnkiError for that action, so one bad note never sinks the batch.
	 */
	async multi(actions: Action[], batchSize = 50, onBatch?: (done: number) => Promise<void> | void): Promise<unknown[]> {
		const out: unknown[] = [];
		for (let i = 0; i < actions.length; i += batchSize) {
			const chunk = actions.slice(i, i + batchSize).map((a) => ({ action: a.action, version: 6, params: a.params ?? {} }));
			const res = await this.call<{ result: unknown; error: string | null }[] | unknown[]>("multi", { actions: chunk });
			for (const r of res) {
				if (r && typeof r === "object" && "error" in r) {
					const rr = r as { result: unknown; error: string | null };
					out.push(rr.error ? new AnkiError(rr.error) : rr.result);
				} else {
					out.push(r);
				}
			}
			if (onBatch) await onBatch(Math.min(i + batchSize, actions.length));
		}
		return out;
	}

	version(): Promise<number> {
		return this.call<number>("version");
	}
}

export interface AnkiNote {
	noteId: number;
	modelName: string;
	tags: string[];
	fields: Record<string, { value: string; order: number }>;
	cards: number[];
}

export interface AnkiCard {
	cardId: number;
	note: number;
	deckName: string;
}

/** notesInfo + cardsInfo for a set of ids; missing notes are simply absent from the map. */
export async function fetchNotes(anki: Anki, ids: number[]): Promise<Map<number, AnkiNote & { decks: string[] }>> {
	const out = new Map<number, AnkiNote & { decks: string[] }>();
	for (let i = 0; i < ids.length; i += 200) {
		const chunk = ids.slice(i, i + 200);
		const notes = await anki.call<(AnkiNote | Record<string, never>)[]>("notesInfo", { notes: chunk });
		const live = notes.filter((n): n is AnkiNote => "noteId" in n);
		const cardIds = live.flatMap((n) => n.cards);
		const cards = cardIds.length ? await anki.call<AnkiCard[]>("cardsInfo", { cards: cardIds }) : [];
		const decksByNote = new Map<number, Set<string>>();
		for (const c of cards) {
			if (!decksByNote.has(c.note)) decksByNote.set(c.note, new Set());
			decksByNote.get(c.note)!.add(c.deckName);
		}
		for (const n of live) out.set(n.noteId, { ...n, decks: [...(decksByNote.get(n.noteId) ?? [])] });
	}
	return out;
}
