import { Anki } from "../src/core/anki";

/** An in-memory AnkiConnect good enough for sync tests. */
export function fakeAnki() {
	let nextId = 1_000_000;
	const notes = new Map<number, { modelName: string; fields: Record<string, string>; tags: string[]; deck: string; cardId: number }>();
	const models = new Set(["Basic", "Cloze", "Basic (type in the answer)"]);
	const decks = new Set(["Default"]);
	const media = new Set<string>();
	const calls: string[] = [];
	const handle = (action: string, p: any): unknown => {
		calls.push(action);
		switch (action) {
			case "multi":
				return p.actions.map((a: any) => {
					try {
						return { result: handle(a.action, a.params), error: null };
					} catch (e) {
						return { result: null, error: String((e as Error).message) };
					}
				});
			case "notesInfo":
				return p.notes.map((id: number) => {
					const n = notes.get(id);
					if (!n) return {};
					return { noteId: id, modelName: n.modelName, tags: n.tags, cards: [n.cardId], fields: Object.fromEntries(Object.entries(n.fields).map(([k, v], i) => [k, { value: v, order: i }])) };
				});
			case "cardsInfo":
				return p.cards.map((c: number) => {
					const [id, n] = [...notes].find(([, x]) => x.cardId === c)!;
					return { cardId: c, note: id, deckName: n.deck };
				});
			case "findNotes": {
				const tags = [...p.query.matchAll(/tag:(\S+)/g)].map((m: RegExpMatchArray) => m[1]);
				return [...notes].filter(([, n]) => n.tags.some((t) => tags.includes(t))).map(([id]) => id);
			}
			case "modelNames":
				return [...models];
			case "createModel":
				models.add(p.modelName);
				return {};
			case "updateModelTemplates":
			case "updateModelStyling":
				return null;
			case "deckNames":
				return [...decks];
			case "createDeck":
				decks.add(p.deck);
				return 1;
			case "getMediaFilesNames":
				return [...media];
			case "storeMediaFile":
				media.add(p.filename);
				return p.filename;
			case "addNote": {
				const id = nextId++;
				notes.set(id, { modelName: p.note.modelName, fields: { ...p.note.fields }, tags: [...p.note.tags], deck: p.note.deckName, cardId: id + 1 });
				return id;
			}
			case "updateNoteModel": {
				const n = notes.get(p.note.id);
				if (!n) throw new Error("note not found");
				Object.assign(n, { modelName: p.note.modelName, fields: { ...p.note.fields }, tags: [...p.note.tags] });
				return null;
			}
			case "updateNoteFields": {
				const n = notes.get(p.note.id)!;
				Object.assign(n.fields, p.note.fields);
				return null;
			}
			case "updateNoteTags":
				notes.get(p.note)!.tags = [...p.tags];
				return null;
			case "changeDeck":
				for (const [, n] of notes) if (p.cards.includes(n.cardId)) n.deck = p.deck;
				return null;
			case "addTags":
				for (const id of p.notes) notes.get(id)!.tags.push(p.tags);
				return null;
			default:
				throw new Error(`fake anki: ${action} not implemented`);
		}
	};
	const anki = new Anki(async (body) => {
		const { action, params } = JSON.parse(body);
		try {
			return JSON.stringify({ result: handle(action, params ?? {}), error: null });
		} catch (e) {
			return JSON.stringify({ result: null, error: (e as Error).message });
		}
	});
	return { anki, notes, models, decks, calls, seed: (id: number, n: { modelName: string; fields: Record<string, string>; tags: string[]; deck: string }) => notes.set(id, { ...n, cardId: id + 1 }) };
}
