import { describe, expect, it } from "vitest";
import {
	daysSinceLastReview,
	fileFromSource,
	formatMinutes,
	groupDecks,
	minutesFor,
	plainText,
	reentry,
	secondsPerCard,
	sessionStatus,
	type DeckRow,
} from "../src/core/dashboard";

describe("timing", () => {
	it("uses the median review time, clamped, with a fallback for thin history", () => {
		expect(secondsPerCard([4000, 5000, 6000, 7000, 90000])).toBe(6);
		expect(secondsPerCard([1000, 1000, 1500, 2000, 2000])).toBe(3);
		expect(secondsPerCard([5000])).toBe(8);
		expect(secondsPerCard([500, 400, 200000, 300000, 600])).toBe(8);
	});
	it("weights new cards more than reviews", () => {
		expect(minutesFor({ newCount: 0, learn: 0, review: 60 }, 10)).toBe(10);
		expect(minutesFor({ newCount: 24, learn: 0, review: 0 }, 10)).toBe(10);
	});
	it("says minutes in words", () => {
		expect(formatMinutes(0)).toBe("nothing");
		expect(formatMinutes(0.4)).toBe("under a minute");
		expect(formatMinutes(13.6)).toBe("about 14 min");
		expect(formatMinutes(80)).toBe("about 1 h 20 min");
		expect(formatMinutes(120)).toBe("about 2 h");
	});
});

describe("groupDecks", () => {
	const names = [
		"Default",
		"Custom Study Session",
		"Languages",
		"Languages::French",
		"Languages::French::5000 words",
		"Languages::Japanese",
		"Medicine",
		"Semester 1",
		"Semester 1::BIO1000",
		"Semester 1::CHEM1000",
	];
	it("shows course decks under a semester, keeps own-time decks apart, hides what's hidden", () => {
		const g = groupDecks(names, ["Languages"], ["Custom Study Session"]);
		expect(g.study).toEqual(["Default", "Medicine", "Semester 1::BIO1000", "Semester 1::CHEM1000"]);
		expect(g.separate).toEqual(["Languages::French", "Languages::Japanese"]);
	});
});

describe("re-entry after a gap", () => {
	const rows: DeckRow[] = [
		{ deck: "S::A", label: "A", root: "S", newCount: 40, learn: 0, review: 3, minutes: 5 },
		{ deck: "S::B", label: "B", root: "S", newCount: 0, learn: 2, review: 30, minutes: 6 },
	];
	it("counts days since the last day with reviews", () => {
		expect(daysSinceLastReview([["2026-11-06", 167], ["2026-11-05", 28]], "2026-11-10")).toBe(4);
		expect(daysSinceLastReview([["2026-11-10", 0], ["2026-11-09", 2]], "2026-11-10")).toBe(1);
		expect(daysSinceLastReview([], "2026-11-10")).toBeNull();
	});
	it("offers a small plan, starting with the deck that has the most due, never the backlog size", () => {
		const r = reentry(4, rows, 10)!;
		expect(r.title).toBe("Welcome back. It's been 4 days.");
		expect(r.startDeck).toBe("S::B");
		expect(r.body).toContain("10 minutes on B");
		expect(r.body).not.toMatch(/\d{2,} cards/);
	});
	it("stays quiet for short gaps", () => {
		expect(reentry(2, rows, 10)).toBeNull();
	});
});

describe("bounded sessions", () => {
	it("tracks minutes and cards toward the bound", () => {
		const s = sessionStatus(0, 252_000, 100, 114, { kind: "minutes", value: 10 });
		expect(s.label).toBe("4:12 of 10:00 · 14 cards");
		expect(s.reached).toBe(false);
		expect(sessionStatus(0, 600_000, 0, 5, { kind: "minutes", value: 10 }).reached).toBe(true);
		const c = sessionStatus(0, 65_000, 10, 30, { kind: "cards", value: 20 });
		expect(c.label).toBe("20 of 20 cards · 1:05");
		expect(c.reached).toBe(true);
	});
});

describe("card previews", () => {
	it("strips HTML, styles and the breadcrumb", () => {
		expect(plainText('<style>.x{}</style><div class="bridge-ctx">BIO1000 › Probability</div><div class="bridge-q">What is <b>x</b>&nbsp;&amp; y?</div>')).toBe("What is x & y?");
	});
	it("reads the vault path from a Source link", () => {
		expect(fileFromSource("obsidian://open?vault=My%20Vault&file=Flashcards%2FBIO1000")).toBe("Flashcards/BIO1000");
		expect(fileFromSource("nope")).toBeNull();
	});
});

import { loadSnapshot } from "../src/core/snapshot";
import { Anki } from "../src/core/anki";

describe("loadSnapshot", () => {
	it("builds rows from AnkiConnect, keeps own-time decks apart, and reuses timing for an hour", async () => {
		const calls: string[] = [];
		const anki = new Anki(async (body) => {
			const { action } = JSON.parse(body) as { action: string };
			calls.push(action);
			const result: Record<string, unknown> = {
				deckNamesAndIds: { "Sem::A": 1, Sem: 2, Languages: 3, "Languages::French": 4 },
				getDeckStats: { "1": { new_count: 10, learn_count: 2, review_count: 8 }, "4": { new_count: 0, learn_count: 0, review_count: 30 } },
				cardReviews: [[0, 0, 0, 0, 0, 0, 0, 6000], [0, 0, 0, 0, 0, 0, 0, 6000], [0, 0, 0, 0, 0, 0, 0, 6000], [0, 0, 0, 0, 0, 0, 0, 6000], [0, 0, 0, 0, 0, 0, 0, 6000]],
				getNumCardsReviewedToday: 3,
				getNumCardsReviewedByDay: [["2026-11-01", 5]],
				findCards: [],
			};
			return JSON.stringify({ result: result[action], error: null });
		});
		const timingCache = new Map<string, { at: number; seconds: number }>();
		const opts = { separateDecks: "Languages", hiddenDecks: "", sessionMinutes: 10, today: "2026-11-10", now: 1_000_000, timingCache };
		const s = await loadSnapshot(anki, opts);
		expect(s.study.map((r) => [r.label, r.minutes])).toEqual([["A", (10 * 6 + 10 * 6 * 2.5) / 60]]);
		expect(s.separate.map((r) => r.label)).toEqual(["French"]);
		expect(s.welcome?.title).toBe("Welcome back. It's been 9 days.");
		const before = calls.filter((c) => c === "cardReviews").length;
		await loadSnapshot(anki, { ...opts, now: 1_000_000 + 60_000 });
		expect(calls.filter((c) => c === "cardReviews").length).toBe(before);
	});
});
