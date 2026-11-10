/**
 * Anki Desk's public API, v1. Companion plugins (Course first) copy this file; it has no runtime
 * dependency on Anki Desk. Versioning is semver on `apiVersion`: minor versions only add.
 */

import type { App } from "obsidian";

export const ANKI_DESK_PLUGIN_ID = "anki-desk";
export const ANKI_DESK_API_VERSION = "1.0.0";

/** Frozen by a test so the contract can't change without a version bump. */
export const ANKI_DESK_API_MEMBERS = ["apiVersion", "dueToday", "ensureDeck", "templates", "draftCard"] as const;

export interface DeckDue {
	/** Full Anki deck name. */
	deck: string;
	/** Last segment, for display. */
	label: string;
	/** Estimated minutes, timed from your own recent reviews. */
	minutes: number;
	newCount: number;
	learn: number;
	review: number;
}

export interface DueToday {
	/** Study decks only: own-time decks (e.g. languages) are excluded, as on the dashboard. */
	decks: DeckDue[];
	totalMinutes: number;
}

export interface CardDraftRequest {
	/** A template id (`basic`, `cloze`, `sequence`, `pair`, `predict`, `explain`, or a vault template). Defaults to `basic`. */
	templateId?: string;
	/** Text the template turns into a card. */
	selection: string;
	heading?: string | null;
	/** Title of the note the card is for. */
	note: string;
	/** Target deck; defaults to Anki Desk's default deck. */
	deck?: string;
}

export interface AnkiDeskApi {
	readonly apiVersion: string;
	/** Today's study load per deck, or null when Anki isn't reachable (or on mobile). */
	dueToday(): Promise<DueToday | null>;
	/** Creates the deck if it doesn't exist. False when Anki isn't reachable. */
	ensureDeck(name: string): Promise<boolean>;
	/** The card templates currently enabled (built-in and vault). */
	templates(): { id: string; label: string; description: string }[];
	/**
	 * Opens Anki Desk's editable card draft. When the user accepts, `insert` receives the finished
	 * card block (Anki Desk syntax) to place in a note; nothing reaches Anki until the next sync.
	 */
	draftCard(request: CardDraftRequest, insert: (block: string) => void): void;
}

/** Finds the API; null if Anki Desk is missing, disabled, still loading, or another major version. */
export function getAnkiDeskApi(app: App): AnkiDeskApi | null {
	const plugins = (app as unknown as { plugins?: { getPlugin?(id: string): unknown } }).plugins;
	const plugin = plugins?.getPlugin?.(ANKI_DESK_PLUGIN_ID) as { api?: AnkiDeskApi } | null | undefined;
	const api = plugin?.api;
	if (!api || typeof api.apiVersion !== "string") return null;
	return api.apiVersion.split(".")[0] === ANKI_DESK_API_VERSION.split(".")[0] ? api : null;
}
