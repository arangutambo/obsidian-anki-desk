/**
 * The study dashboard's arithmetic, kept pure so it can be tested without Anki or Obsidian.
 *
 * Design rules it implements:
 * - Work is shown in minutes, not card counts: a count says nothing about how long it takes.
 * - Sessions are bounded before they start (minutes or cards), and ending one is a soft cue,
 *   never a forced stop.
 * - After days away, the first thing shown is a small plan, not the size of the backlog.
 * - Decks the user keeps for their own time (languages, hobbies) are listed apart and never
 *   counted in the day's total.
 */

export interface DeckCounts {
	newCount: number;
	learn: number;
	review: number;
}

export interface DeckRow extends DeckCounts {
	/** Full Anki deck name. */
	deck: string;
	/** Last segment, for display. */
	label: string;
	/** Top-level deck it belongs to (used for timing). */
	root: string;
	minutes: number;
}

/** New cards take longer than reviews: several learning steps on the first day. */
export const NEW_CARD_WEIGHT = 2.5;
export const DEFAULT_SECONDS = 8;

/** Typical seconds per review from recent review durations (ms). Median, clamped to 3–60 s. */
export function secondsPerCard(durationsMs: number[], fallback = DEFAULT_SECONDS): number {
	const xs = durationsMs.filter((d) => d >= 1000 && d <= 120_000).sort((a, b) => a - b);
	if (xs.length < 5) return fallback;
	const mid = xs.length >> 1;
	const median = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
	return Math.min(60, Math.max(3, median / 1000));
}

export function minutesFor(c: DeckCounts, seconds: number): number {
	const s = (c.learn + c.review) * seconds + c.newCount * seconds * NEW_CARD_WEIGHT;
	return s / 60;
}

export function formatMinutes(m: number): string {
	if (m <= 0) return "nothing";
	if (m < 1) return "under a minute";
	const r = Math.round(m);
	if (r < 60) return `about ${r} min`;
	const h = Math.floor(r / 60);
	const rest = r % 60;
	return rest ? `about ${h} h ${rest} min` : `about ${h} h`;
}

/**
 * Splits Anki's deck list into the rows the dashboard shows. A top-level deck with children is
 * shown as its children (the course decks); one without is shown as itself.
 */
export function groupDecks(names: string[], separate: string[], hidden: string[]): { study: string[]; separate: string[] } {
	const isUnder = (name: string, root: string) => name === root || name.startsWith(root + "::");
	const tops = names.filter((n) => !n.includes("::"));
	const study: string[] = [];
	const sep: string[] = [];
	for (const top of tops) {
		if (hidden.some((h) => isUnder(top, h))) continue;
		const children = names.filter((n) => n.startsWith(top + "::") && n.split("::").length === 2);
		const rows = (children.length ? children : [top]).filter((r) => !hidden.some((h) => isUnder(r, h)));
		(separate.some((s) => isUnder(top, s)) ? sep : study).push(...rows);
	}
	return { study, separate: sep };
}

export function rootOf(deck: string): string {
	return deck.split("::")[0];
}

export function labelOf(deck: string): string {
	return deck.split("::").pop() ?? deck;
}

export function hasWork(c: DeckCounts): boolean {
	return c.newCount + c.learn + c.review > 0;
}

/**
 * Days since the last day with any reviews. `byDay` is AnkiConnect's
 * getNumCardsReviewedByDay ([["2026-11-09", 2], …], newest first). Null if never reviewed.
 */
export function daysSinceLastReview(byDay: [string, number][], today: string): number | null {
	const last = byDay.filter(([, n]) => n > 0).map(([d]) => d).sort().pop();
	if (!last) return null;
	const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`);
	return Math.max(0, Math.round(ms / 86_400_000));
}

export const REENTRY_DAYS = 3;

export interface Reentry {
	title: string;
	body: string;
	/** Deck to suggest starting with, if any work is due. */
	startDeck: string | null;
}

export function reentry(days: number | null, rows: DeckRow[], sessionMinutes: number): Reentry | null {
	if (days === null || days < REENTRY_DAYS) return null;
	const due = rows.filter((r) => r.learn + r.review > 0).sort((a, b) => b.learn + b.review - (a.learn + a.review));
	const start = due[0] ?? null;
	return {
		title: `Welcome back. It's been ${days} days.`,
		body: start
			? `No need to catch up all at once. Start with ${sessionMinutes} minutes on ${start.label}; the oldest cards come first. You can pause new cards until things feel manageable again.`
			: "Nothing has piled up. Pick up where you like.",
		startDeck: start?.deck ?? null,
	};
}

export type Bound = { kind: "minutes"; value: number } | { kind: "cards"; value: number };

export interface SessionStatus {
	elapsedSeconds: number;
	cards: number;
	/** 0–1 progress toward the bound. */
	fraction: number;
	reached: boolean;
	label: string;
}

export function sessionStatus(startedAt: number, now: number, reviewedAtStart: number, reviewedNow: number, bound: Bound): SessionStatus {
	const elapsedSeconds = Math.max(0, Math.round((now - startedAt) / 1000));
	const cards = Math.max(0, reviewedNow - reviewedAtStart);
	const fraction = bound.kind === "minutes" ? elapsedSeconds / (bound.value * 60) : cards / bound.value;
	const reached = fraction >= 1;
	const clock = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
	const label =
		bound.kind === "minutes"
			? `${clock} of ${bound.value}:00 · ${cards} card${cards === 1 ? "" : "s"}`
			: `${cards} of ${bound.value} cards · ${clock}`;
	return { elapsedSeconds, cards, fraction: Math.min(1, fraction), reached, label };
}

/** Strips Anki's HTML for a one-line preview of a card's front. */
export function plainText(html: string, max = 120): string {
	const t = html
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<div class="bridge-ctx">[\s\S]*?<\/div>/g, "")
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
	return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** The vault path inside an obsidian://open Source link, or null. */
export function fileFromSource(source: string): string | null {
	const m = /[?&]file=([^&]+)/.exec(source);
	if (!m) return null;
	try {
		return decodeURIComponent(m[1]);
	} catch {
		return null;
	}
}
