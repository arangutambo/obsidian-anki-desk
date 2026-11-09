import { App, ItemView, Modal, Notice, Setting, type WorkspaceLeaf } from "obsidian";

import { formatMinutes, labelOf, sessionStatus, type Bound, type DeckRow } from "./core/dashboard";
import { loadSnapshot, type Snapshot } from "./core/snapshot";
import type AnkiDesk from "./main";

export const VIEW_TYPE = "anki-desk-dashboard";

interface Session {
	deck: string;
	label: string;
	bound: Bound;
	startedAt: number;
	reviewedAtStart: number;
	reviewedNow: number;
	notified: boolean;
}

/**
 * The study dashboard: what's due today in minutes, bounded sessions that open Anki's own
 * reviewer, a gentle plan after days away, and cards worth rewriting. Anki is only asked
 * while the view is visible.
 */
export class DashboardView extends ItemView {
	private snapshot: Snapshot | null = null;
	private error: string | null = null;
	private session: Session | null = null;
	private ticker: number | null = null;
	private busy = false;
	private timing = new Map<string, { at: number; seconds: number }>();

	constructor(leaf: WorkspaceLeaf, private plugin: AnkiDesk) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}
	getDisplayText(): string {
		return "Study dashboard";
	}
	override getIcon(): string {
		return "layers";
	}

	override async onOpen(): Promise<void> {
		this.contentEl.addClass("anki-desk-dash");
		await this.refresh();
		this.registerInterval(
			window.setInterval(() => {
				if (this.contentEl.isShown() && !this.session) void this.refresh();
			}, 60_000),
		);
	}

	override onClose(): Promise<void> {
		this.stopTicker();
		return Promise.resolve();
	}

	async refresh(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			const anki = this.plugin.anki();
			if (!anki) {
				this.error = "The dashboard needs the desktop app, where Anki runs.";
			} else {
				try {
					await anki.version();
					const p = this.plugin.prefs;
					this.snapshot = await loadSnapshot(anki, { separateDecks: p.separateDecks, hiddenDecks: p.hiddenDecks, sessionMinutes: p.sessionMinutes, today: new Date().toLocaleDateString("en-CA"), now: Date.now(), timingCache: this.timing });
					this.error = null;
				} catch {
					this.error = "Anki isn't open. Open it and this view fills in.";
				}
			}
		} finally {
			this.busy = false;
		}
		this.render();
	}

	private render(): void {
		const el = this.contentEl;
		el.empty();
		const head = el.createDiv({ cls: "anki-desk-head" });
		head.createEl("h3", { text: "Today" });
		const refresh = head.createEl("button", { text: "Refresh", cls: "anki-desk-quiet" });
		refresh.addEventListener("click", () => void this.refresh());

		if (this.error) {
			el.createEl("p", { text: this.error, cls: "anki-desk-muted" });
			return;
		}
		const snap = this.snapshot;
		if (!snap) return;
		const p = this.plugin.prefs;

		const total = snap.study.reduce((a, r) => a + r.minutes, 0);
		el.createEl("p", {
			cls: "anki-desk-total",
			text: total > 0 ? `${formatMinutes(total)[0].toUpperCase()}${formatMinutes(total).slice(1)} of study.` : "Nothing due. That's today done.",
		});
		if (snap.reviewedToday) el.createEl("p", { cls: "anki-desk-muted", text: `${snap.reviewedToday} cards reviewed today.` });

		if (this.session) this.renderSession(el, this.session);

		if (p.paused) {
			const box = el.createDiv({ cls: "anki-desk-note" });
			box.createEl("p", { text: `New cards are paused (since ${p.paused.since}). Reviews carry on as normal.` });
			box.createEl("button", { text: "Resume new cards" }).addEventListener("click", () => void this.resumeNew());
		} else if (snap.welcome && !this.session) {
			const box = el.createDiv({ cls: "anki-desk-note" });
			box.createEl("p", { text: snap.welcome.title, cls: "anki-desk-strong" });
			box.createEl("p", { text: snap.welcome.body });
			const row = box.createDiv({ cls: "anki-desk-buttons" });
			const start = snap.welcome.startDeck;
			if (start) {
				row.createEl("button", { text: `Start ${p.sessionMinutes} minutes`, cls: "mod-cta" }).addEventListener("click", () =>
					void this.startSession(start, { kind: "minutes", value: p.sessionMinutes }),
				);
			}
			row.createEl("button", { text: "Pause new cards" }).addEventListener("click", () => this.confirmPause());
		}

		this.renderRows(el, snap.study, "Nothing due in your study decks.");

		if (snap.leeches.length) {
			const d = el.createEl("details", { cls: "anki-desk-section" });
			d.createEl("summary", { text: `Cards to rewrite (${snap.leeches.length})` });
			d.createEl("p", {
				cls: "anki-desk-muted",
				text: "You've missed these many times. Usually the card is the problem, not you: split it, add context, or ask it differently.",
			});
			const ul = d.createEl("ul");
			for (const l of snap.leeches) {
				const li = ul.createEl("li");
				li.createSpan({ text: l.text });
				const file = l.file;
				if (file) {
					li.createEl("button", { text: "Open note", cls: "anki-desk-quiet" }).addEventListener("click", () => {
						void this.app.workspace.openLinkText(file, "", true);
					});
				}
			}
		}

		if (snap.separate.length) {
			const d = el.createEl("details", { cls: "anki-desk-section" });
			const own = snap.separate.reduce((a, r) => a + r.minutes, 0);
			d.createEl("summary", { text: `On your own time (${formatMinutes(own)})` });
			d.createEl("p", { cls: "anki-desk-muted", text: "Kept apart from your study total. Open when you feel like it." });
			this.renderRows(d, snap.separate, "");
		}

		el.createEl("p", { cls: "anki-desk-muted anki-desk-foot", text: `Updated ${snap.updated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` });
	}

	private renderRows(parent: HTMLElement, rows: DeckRow[], empty: string): void {
		if (!rows.length) {
			if (empty) parent.createEl("p", { cls: "anki-desk-muted", text: empty });
			return;
		}
		const p = this.plugin.prefs;
		const list = parent.createDiv({ cls: "anki-desk-rows" });
		for (const r of [...rows].sort((a, b) => b.minutes - a.minutes)) {
			const row = list.createDiv({ cls: "anki-desk-row" });
			const text = row.createDiv({ cls: "anki-desk-row-text" });
			text.createDiv({ text: r.label, cls: "anki-desk-strong" });
			const parts = [r.newCount && `${r.newCount} new`, r.learn && `${r.learn} learning`, r.review && `${r.review} to review`].filter(Boolean);
			text.createDiv({ cls: "anki-desk-muted", text: `${formatMinutes(r.minutes)} · ${parts.join(" · ")}` });
			const buttons = row.createDiv({ cls: "anki-desk-buttons" });
			buttons.createEl("button", { text: `${p.sessionMinutes} min` }).addEventListener("click", () =>
				void this.startSession(r.deck, { kind: "minutes", value: p.sessionMinutes }),
			);
			buttons.createEl("button", { text: `${p.sessionCards} cards` }).addEventListener("click", () =>
				void this.startSession(r.deck, { kind: "cards", value: p.sessionCards }),
			);
		}
	}

	private renderSession(parent: HTMLElement, s: Session): void {
		const st = sessionStatus(s.startedAt, Date.now(), s.reviewedAtStart, s.reviewedNow, s.bound);
		const box = parent.createDiv({ cls: "anki-desk-session" });
		box.createDiv({ cls: "anki-desk-strong", text: st.reached ? `${s.label}: that's your session. Well done.` : `${s.label}: reviewing in Anki` });
		box.createEl("progress", { attr: { max: "1", value: String(st.fraction) } });
		box.createDiv({ cls: "anki-desk-muted", text: st.label });
		const row = box.createDiv({ cls: "anki-desk-buttons" });
		row.createEl("button", { text: "Back to decks" }).addEventListener("click", () => {
			void this.plugin.anki()?.call("guiDeckBrowser");
			this.endSession();
		});
		row.createEl("button", { text: st.reached ? "Done" : "Stop tracking", cls: "anki-desk-quiet" }).addEventListener("click", () => this.endSession());
	}

	async startSession(deck: string, bound: Bound): Promise<void> {
		const anki = this.plugin.anki();
		if (!anki) return;
		try {
			const reviewed = await anki.call<number>("getNumCardsReviewedToday");
			await anki.call("guiDeckReview", { name: deck });
			this.session = { deck, label: labelOf(deck), bound, startedAt: Date.now(), reviewedAtStart: reviewed, reviewedNow: reviewed, notified: false };
			this.stopTicker();
			this.ticker = window.setInterval(() => void this.tick(), 5000);
			this.registerInterval(this.ticker);
			this.render();
		} catch (e) {
			new Notice(`Couldn't start the session: ${(e as Error).message}`);
		}
	}

	private async tick(): Promise<void> {
		const s = this.session;
		const anki = this.plugin.anki();
		if (!s || !anki) return;
		try {
			s.reviewedNow = await anki.call<number>("getNumCardsReviewedToday");
		} catch {
			return;
		}
		const st = sessionStatus(s.startedAt, Date.now(), s.reviewedAtStart, s.reviewedNow, s.bound);
		if (st.reached && !s.notified) {
			s.notified = true;
			const what = s.bound.kind === "minutes" ? `${s.bound.value} minutes` : `${s.bound.value} cards`;
			new Notice(`That's your ${what}. Stop here, or finish the card you're on.`, 15_000);
			if (this.plugin.prefs.hardStop) void anki.call("guiDeckBrowser");
		}
		// A session left running quietly ends itself at twice its bound.
		if (st.fraction >= 1 && (Date.now() - s.startedAt > 2 * 60_000 * (s.bound.kind === "minutes" ? s.bound.value : 10))) {
			this.endSession();
			return;
		}
		if (this.contentEl.isShown()) this.render();
	}

	private endSession(): void {
		this.session = null;
		this.stopTicker();
		void this.refresh();
	}

	private stopTicker(): void {
		if (this.ticker !== null) window.clearInterval(this.ticker);
		this.ticker = null;
	}

	/** Pausing new cards is a settings change in Anki, so it is previewed and undoable. */
	private confirmPause(): void {
		void (async () => {
			const anki = this.plugin.anki();
			const snap = this.snapshot;
			if (!anki || !snap) return;
			const configs = new Map<number, { id: number; name: string; perDay: number; deck: string }>();
			for (const r of snap.study) {
				const c = await anki.call<{ id: number; name: string; new: { perDay: number } }>("getDeckConfig", { deck: r.deck });
				if (!configs.has(c.id) && c.new.perDay > 0) configs.set(c.id, { id: c.id, name: c.name, perDay: c.new.perDay, deck: r.deck });
			}
			if (!configs.size) {
				new Notice("New cards are already at zero in your study decks.");
				return;
			}
			new PauseModal(this.app, [...configs.values()], async () => {
				for (const c of configs.values()) {
					const full = await anki.call<{ new: { perDay: number } }>("getDeckConfig", { deck: c.deck });
					full.new.perDay = 0;
					await anki.call("saveDeckConfig", { config: full });
				}
				this.plugin.prefs.paused = { since: new Date().toLocaleDateString(), configs: [...configs.values()] };
				await this.plugin.saveSettings();
				await this.refresh();
			}).open();
		})();
	}

	private async resumeNew(): Promise<void> {
		const anki = this.plugin.anki();
		const paused = this.plugin.prefs.paused;
		if (!anki || !paused) return;
		for (const c of paused.configs) {
			const full = await anki.call<{ id: number; new: { perDay: number } }>("getDeckConfig", { deck: c.deck });
			if (full.id === c.id) {
				full.new.perDay = c.perDay;
				await anki.call("saveDeckConfig", { config: full });
			}
		}
		this.plugin.prefs.paused = null;
		await this.plugin.saveSettings();
		new Notice("New cards are back on.");
		await this.refresh();
	}
}

class PauseModal extends Modal {
	constructor(app: App, private configs: { name: string; perDay: number }[], private onConfirm: () => Promise<void>) {
		super(app);
	}
	override onOpen(): void {
		this.setTitle("Pause new cards?");
		const { contentEl } = this;
		contentEl.createEl("p", { text: "Reviews carry on; no new cards are introduced until you resume. This changes these Anki presets:" });
		const ul = contentEl.createEl("ul");
		for (const c of this.configs) ul.createEl("li", { text: `${c.name}: ${c.perDay} new a day → 0` });
		contentEl.createEl("p", { cls: "anki-desk-muted", text: "Resume puts the old numbers back." });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Pause new cards")
					.setCta()
					.onClick(() => {
						void this.onConfirm().then(() => this.close());
					}),
			);
	}
	override onClose(): void {
		this.contentEl.empty();
	}
}
