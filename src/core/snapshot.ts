/**
 * Gathers everything the study dashboard shows, from AnkiConnect. Pure (no Obsidian), so the
 * plugin view and the command-line preview run exactly the same code.
 */

import type { Anki } from "./anki";
import {
	daysSinceLastReview,
	fileFromSource,
	groupDecks,
	hasWork,
	labelOf,
	minutesFor,
	plainText,
	reentry,
	rootOf,
	secondsPerCard,
	type DeckRow,
	type Reentry,
} from "./dashboard";

export interface Leech {
	cardId: number;
	text: string;
	file: string | null;
}

export interface Snapshot {
	study: DeckRow[];
	separate: DeckRow[];
	reviewedToday: number;
	welcome: Reentry | null;
	leeches: Leech[];
	updated: Date;
}

export interface SnapshotOptions {
	separateDecks: string;
	hiddenDecks: string;
	sessionMinutes: number;
	/** Local date, YYYY-MM-DD. */
	today: string;
	now: number;
	/** Seconds-per-card by top-level deck, reused for an hour so refreshes stay cheap. */
	timingCache?: Map<string, { at: number; seconds: number }>;
}

type StatsEntry = { new_count: number; learn_count: number; review_count: number };

export async function loadSnapshot(anki: Anki, p: SnapshotOptions): Promise<Snapshot> {
	const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
	const ids = await anki.call<Record<string, number>>("deckNamesAndIds");
	const groups = groupDecks(Object.keys(ids), list(p.separateDecks), list(p.hiddenDecks));
	const all = [...groups.study, ...groups.separate];
	const stats = all.length ? await anki.call<Record<string, StatsEntry>>("getDeckStats", { decks: all }) : {};

	const since = p.now - 30 * 86_400_000;
	const seconds = new Map<string, number>();
	for (const root of new Set(all.map(rootOf))) {
		const cached = p.timingCache?.get(root);
		if (cached && p.now - cached.at < 3_600_000) {
			seconds.set(root, cached.seconds);
			continue;
		}
		const rows = await anki.call<number[][]>("cardReviews", { deck: root, startID: since });
		const sec = secondsPerCard(rows.map((r) => r[7]));
		seconds.set(root, sec);
		p.timingCache?.set(root, { at: p.now, seconds: sec });
	}
	const toRow = (deck: string): DeckRow => {
		const s = stats[String(ids[deck])] ?? { new_count: 0, learn_count: 0, review_count: 0 };
		const c = { newCount: s.new_count, learn: s.learn_count, review: s.review_count };
		return { deck, label: labelOf(deck), root: rootOf(deck), ...c, minutes: minutesFor(c, seconds.get(rootOf(deck)) ?? 8) };
	};
	const study = groups.study.map(toRow).filter(hasWork);
	const separate = groups.separate.map(toRow).filter(hasWork);

	const reviewedToday = await anki.call<number>("getNumCardsReviewedToday");
	const byDay = await anki.call<[string, number][]>("getNumCardsReviewedByDay");
	const welcome = reentry(daysSinceLastReview(byDay, p.today), study, p.sessionMinutes);

	const scope = groups.study.map((d) => `"deck:${d}"`).join(" OR ");
	const leechIds = scope ? (await anki.call<number[]>("findCards", { query: `tag:leech (${scope})` })).slice(0, 20) : [];
	const leeches: Leech[] = [];
	if (leechIds.length) {
		const cards = await anki.call<{ cardId: number; note: number; question: string }[]>("cardsInfo", { cards: leechIds });
		const notes = await anki.call<{ noteId: number; fields: Record<string, { value: string }> }[]>("notesInfo", {
			notes: [...new Set(cards.map((c) => c.note))],
		});
		const source = new Map(notes.map((n) => [n.noteId, n.fields.Source?.value ?? ""]));
		for (const c of cards) leeches.push({ cardId: c.cardId, text: plainText(c.question), file: fileFromSource(source.get(c.note) ?? "") });
	}
	return { study, separate, reviewedToday, welcome, leeches, updated: new Date(p.now) };
}
