import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	SuggestModal,
	TFile,
	arrayBufferToBase64,
	requestUrl,
} from "obsidian";

import { Anki } from "./core/anki";
import { renderField } from "./core/render";
import { lintCard } from "./core/lint";
import { modelByName } from "./core/models";
import { formatBlock } from "./core/parse";
import { BUILTINS, mergeTemplates, parseTemplates, type CardDraft, type Template, type TemplateContext } from "./core/templates";
import { EMPTY_STATE, sync, type SyncReport, type SyncState, type VaultPort } from "./core/sync";
import { DashboardView, VIEW_TYPE } from "./view";

interface Settings {
	ankiUrl: string;
	cardFolders: string;
	defaultDeck: string;
	templatesNote: string;
	disabledTemplates: string;
	managedTag: string;
	/** Top-level decks reviewed on your own time: listed apart, never in the day's total. */
	separateDecks: string;
	/** Decks the dashboard ignores. */
	hiddenDecks: string;
	sessionMinutes: number;
	sessionCards: number;
	/** Send Anki back to the deck list when a session's bound is reached. */
	hardStop: boolean;
	/** Presets whose new cards were paused from the dashboard, with the values to restore. */
	paused: { since: string; configs: { id: number; name: string; perDay: number; deck: string }[] } | null;
}

type StringKey = { [K in keyof Settings]: Settings[K] extends string ? K : never }[keyof Settings];

const DEFAULTS: Settings = {
	ankiUrl: "http://127.0.0.1:8765",
	cardFolders: "Flashcards",
	defaultDeck: "Default",
	templatesNote: "Anki Desk Templates.md",
	disabledTemplates: "",
	managedTag: "bridge",
	separateDecks: "",
	hiddenDecks: "Custom Study Session",
	sessionMinutes: 10,
	sessionCards: 20,
	hardStop: false,
	paused: null,
};

export default class AnkiDesk extends Plugin {
	prefs: Settings = { ...DEFAULTS };
	templates: Template[] = BUILTINS;
	private syncing = false;

	override async onload(): Promise<void> {
		this.prefs = { ...DEFAULTS, ...((await this.loadData()) as Partial<Settings>) };
		this.addSettingTab(new BridgeSettings(this.app, this));
		this.addCommand({ id: "sync", name: "Sync cards to Anki", callback: () => void this.runSync(false) });
		this.addCommand({ id: "preview-sync", name: "Preview sync (changes nothing)", callback: () => void this.runSync(true) });
		this.addCommand({
			id: "new-card",
			name: "New card…",
			editorCallback: (editor, view) => new TemplatePicker(this, editor, view as MarkdownView).open(),
		});
		this.addCommand({ id: "reload-templates", name: "Reload card templates", callback: () => void this.loadTemplates(true) });
		this.registerView(VIEW_TYPE, (leaf) => new DashboardView(leaf, this));
		this.addRibbonIcon("layers", "Open study dashboard", () => void this.openDashboard());
		this.addCommand({ id: "open-dashboard", name: "Open study dashboard", callback: () => void this.openDashboard() });
		// Templates live in a note, so they are read once the vault is ready, never at load.
		this.app.workspace.onLayoutReady(() => void this.loadTemplates(false));
	}

	/** An AnkiConnect client, or null on mobile where AnkiConnect can't be reached. */
	anki(): Anki | null {
		if (!Platform.isDesktopApp) return null;
		return new Anki(async (body) => (await requestUrl({ url: this.prefs.ankiUrl, method: "POST", body, throw: false })).text);
	}

	async openDashboard(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			const right = workspace.getRightLeaf(false);
			if (!right) return;
			await right.setViewState({ type: VIEW_TYPE, active: true });
			leaf = right;
		}
		await workspace.revealLeaf(leaf);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.prefs);
	}

	async loadTemplates(announce: boolean): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(this.prefs.templatesNote);
		let vaultTemplates: Template[] = [];
		if (file instanceof TFile) {
			const { templates, errors } = parseTemplates(await this.app.vault.cachedRead(file), file.path);
			vaultTemplates = templates;
			for (const e of errors) new Notice(`Anki Desk: ${e}`);
		}
		const disabled = this.prefs.disabledTemplates.split(",").map((s) => s.trim()).filter(Boolean);
		this.templates = mergeTemplates(BUILTINS, vaultTemplates, disabled);
		for (const t of this.templates) {
			this.addCommand({
				id: `new-card-${t.id}`,
				name: `New card: ${t.label}`,
				editorCallback: (editor, view) => this.draft(t, editor, view as MarkdownView),
			});
		}
		if (announce) new Notice(`Anki Desk: ${this.templates.length} card templates ready.`);
	}

	draft(t: Template, editor: Editor, view: MarkdownView): void {
		const file = view.file;
		if (!file) return;
		const cache = this.app.metadataCache.getFileCache(file);
		const cursor = editor.getCursor("from").line;
		const heading = [...(cache?.headings ?? [])].reverse().find((h) => h.position.start.line <= cursor)?.heading ?? null;
		const ctx: TemplateContext = {
			selection: editor.getSelection(),
			heading,
			note: file.basename,
			deck: (cache?.frontmatter?.["anki-deck"] as string | undefined) ?? this.targetDeckAbove(editor, cursor) ?? this.prefs.defaultDeck,
		};
		new DraftModal(this.app, t.make(ctx), ctx.deck, (block) => {
			editor.replaceSelection(block + "\n");
			if (!this.isCardFile(file)) {
				new Notice("Anki Desk: this note isn't a card file yet. Add `anki-deck:` to its frontmatter (or move cards to a card folder) so sync finds it.", 10_000);
			}
		}).open();
	}

	private targetDeckAbove(editor: Editor, line: number): string | null {
		for (let l = line; l >= 0; l--) {
			const m = /^TARGET DECK:?\s*(.*)$/.exec(editor.getLine(l));
			if (m) return m[1].trim() || editor.getLine(l + 1).trim() || null;
		}
		return null;
	}

	isCardFile(file: TFile): boolean {
		const folders = this.prefs.cardFolders.split(",").map((s) => s.trim().replace(/\/?$/, "/")).filter((s) => s !== "/");
		if (folders.some((f) => file.path.startsWith(f))) return true;
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return !!fm && (typeof fm["anki-deck"] === "string" || fm.anki === true);
	}

	async runSync(dryRun: boolean): Promise<void> {
		if (!Platform.isDesktopApp) {
			new Notice("Syncing cards needs the desktop app, where Anki runs.");
			return;
		}
		if (this.syncing) return;
		this.syncing = true;
		const notice = new Notice(dryRun ? "Anki Desk: previewing…" : "Anki Desk: syncing…", 0);
		try {
			const anki = this.anki();
			if (!anki) return;
			try {
				await anki.version();
			} catch {
				notice.hide();
				new Notice("Anki isn't reachable. Open Anki and try again.", 8000);
				return;
			}
			const report = await sync(anki, this.vaultPort(), this.statePort(), {
				defaultDeck: this.prefs.defaultDeck,
				managedTag: this.prefs.managedTag,
				orphanTag: `${this.prefs.managedTag}::orphan`,
				dryRun,
				recreateMissing: false,
				keepTags: ["leech", "marked"],
				dropTags: ["Obsidian_to_Anki"],
			});
			notice.hide();
			new ReportModal(this.app, report, dryRun).open();
		} catch (e) {
			notice.hide();
			new Notice(`Anki Desk: sync stopped: ${(e as Error).message}`, 10_000);
		} finally {
			this.syncing = false;
		}
	}

	private vaultPort(): VaultPort {
		const { vault, metadataCache } = this.app;
		return {
			vaultName: vault.getName(),
			listCardFiles: async () =>
				vault
					.getMarkdownFiles()
					.filter((f) => this.isCardFile(f))
					.map((f) => ({ path: f.path, frontmatterDeck: (metadataCache.getFileCache(f)?.frontmatter?.["anki-deck"] as string | undefined) ?? null })),
			read: async (path) => {
				const f = vault.getAbstractFileByPath(path);
				return f instanceof TFile ? vault.read(f) : "";
			},
			writeIfUnchanged: async (path, expected, next) => {
				const f = vault.getAbstractFileByPath(path);
				if (!(f instanceof TFile)) return false;
				let wrote = false;
				await vault.process(f, (data) => {
					if (data !== expected) return data;
					wrote = true;
					return next;
				});
				return wrote;
			},
			readMedia: async (target, fromPath) => {
				const f = metadataCache.getFirstLinkpathDest(target, fromPath);
				return f ? arrayBufferToBase64(await vault.readBinary(f)) : null;
			},
		};
	}

	private statePort() {
		const path = `${this.manifest.dir}/state.json`;
		const adapter = this.app.vault.adapter;
		return {
			load: async (): Promise<SyncState> => {
				try {
					return JSON.parse(await adapter.read(path)) as SyncState;
				} catch {
					return structuredClone(EMPTY_STATE);
				}
			},
			save: async (s: SyncState) => adapter.write(path, JSON.stringify(s)),
		};
	}
}

class TemplatePicker extends SuggestModal<Template> {
	constructor(private plugin: AnkiDesk, private editor: Editor, private view: MarkdownView) {
		super(plugin.app);
		this.setPlaceholder("Which kind of card?");
	}
	getSuggestions(q: string): Template[] {
		const s = q.toLowerCase();
		return this.plugin.templates.filter((t) => t.label.toLowerCase().includes(s) || t.id.includes(s));
	}
	renderSuggestion(t: Template, el: HTMLElement): void {
		el.createDiv({ text: t.label });
		el.createEl("small", { text: t.description, cls: "anki-desk-muted" });
	}
	onChooseSuggestion(t: Template): void {
		this.plugin.draft(t, this.editor, this.view);
	}
}

/** Draft first: edit the fields, see the quality checks, then insert. Nothing reaches Anki until sync. */
class DraftModal extends Modal {
	constructor(app: App, private card: CardDraft, private deck: string, private onAccept: (block: string) => void) {
		super(app);
	}
	override onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("anki-desk-draft");
		const model = modelByName(this.card.noteType);
		if (!model) return;
		this.setTitle(`${this.card.noteType} → ${this.deck}`);
		const fields = { ...this.card.fields };
		const lintBox = contentEl.createDiv({ cls: "anki-desk-lints" });
		const relint = () => {
			lintBox.empty();
			const html = Object.fromEntries(model.authored.map((n) => [n, renderField(fields[n] ?? "", { cloze: model.isCloze && n === model.authored[0] }).html]));
			for (const l of lintCard({ noteType: this.card.noteType, fields, html, tags: this.card.tags })) {
				lintBox.createDiv({ text: `${l.level === "warn" ? "⚠︎" : "ℹ︎"} ${l.message}` });
			}
		};
		for (const name of model.authored) {
			new Setting(contentEl).setName(name).addTextArea((ta) => {
				ta.setValue(fields[name] ?? "").onChange((v) => {
					fields[name] = v;
					relint();
				});
				ta.inputEl.rows = name === model.authored[0] ? 3 : 5;
			});
		}
		let tags = this.card.tags.join(" ");
		new Setting(contentEl).setName("Tags").addText((t) => t.setValue(tags).onChange((v) => (tags = v)));
		relint();
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Discard").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Insert card")
					.setCta()
					.onClick(() => {
						this.onAccept(formatBlock(this.card.noteType, model.authored, fields, tags.split(/\s+/).filter(Boolean)));
						this.close();
					}),
			);
		this.scope.register(["Mod"], "Enter", () => {
			this.onAccept(formatBlock(this.card.noteType, model.authored, fields, tags.split(/\s+/).filter(Boolean)));
			this.close();
			return false;
		});
	}
	override onClose(): void {
		this.contentEl.empty();
	}
}

class ReportModal extends Modal {
	constructor(app: App, private report: SyncReport, private dryRun: boolean) {
		super(app);
	}
	override onOpen(): void {
		const { contentEl } = this;
		const s = this.report.summary;
		this.setTitle(this.dryRun ? "Preview: nothing has changed yet" : "Sync finished");
		const ul = contentEl.createEl("ul");
		const line = (label: string, n: number | undefined) => n && ul.createEl("li", { text: `${label}: ${n}` });
		line(this.dryRun ? "New cards to add" : "New cards added", this.dryRun ? s.create : this.report.applied?.created);
		line(this.dryRun ? "Cards to update" : "Cards updated", this.dryRun ? (s.update ?? 0) + (s.convert ?? 0) : (this.report.applied?.updated ?? 0) + (this.report.applied?.converted ?? 0));
		line("Unchanged", s.unchanged);
		line("IDs in notes that Anki no longer has (left alone)", s.missing);
		line("Cards in Anki no note mentions any more (tagged, never deleted)", s.orphans);
		line("Duplicate IDs (skipped, fix by hand)", s.duplicate);
		const problems = this.report.files.flatMap((f) => f.problems.map((p) => `${f.path}:${p.line} ${p.kind} ${p.detail}`));
		const failures = this.report.applied?.failures ?? [];
		if (problems.length || failures.length) {
			contentEl.createEl("h4", { text: "Needs a look" });
			const pl = contentEl.createEl("ul");
			for (const p of [...problems, ...failures].slice(0, 30)) pl.createEl("li", { text: p });
		}
		if (!ul.childElementCount) contentEl.createEl("p", { text: "Everything is already in step. Nothing to do." });
	}
	override onClose(): void {
		this.contentEl.empty();
	}
}

class BridgeSettings extends PluginSettingTab {
	constructor(app: App, private plugin: AnkiDesk) {
		super(app, plugin);
	}
	override display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.prefs;
		const text = (name: string, desc: string, key: StringKey) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((t) =>
					t.setValue(s[key]).onChange(async (v) => {
						s[key] = v;
						await this.plugin.saveSettings();
					}),
				);
		text("Card folders", "Comma-separated. Every note in these folders is read for cards. Notes elsewhere need `anki-deck:` (or `anki: true`) in their frontmatter.", "cardFolders");
		text("Default deck", "Used when a note sets no deck and has no TARGET DECK line.", "defaultDeck");
		text("Templates note", "A note holding your own `anki-template` blocks. They add to, or replace, the built-in templates.", "templatesNote");
		text("Turned-off templates", "Comma-separated template ids to hide (basic, cloze, sequence, pair, predict, explain).", "disabledTemplates");
		text("AnkiConnect address", "Local only. Nothing else leaves your computer.", "ankiUrl");

		new Setting(containerEl).setName("Study dashboard").setHeading();
		text("Own-time decks", "Comma-separated top-level decks (e.g. Languages) listed apart and left out of the day's total.", "separateDecks");
		text("Hidden decks", "Comma-separated decks the dashboard ignores.", "hiddenDecks");
		const num = (name: string, desc: string, key: "sessionMinutes" | "sessionCards") =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((t) =>
					t.setValue(String(s[key])).onChange(async (v) => {
						const n = Number(v);
						if (Number.isFinite(n) && n > 0) {
							s[key] = Math.round(n);
							await this.plugin.saveSettings();
						}
					}),
				);
		num("Session length (minutes)", "The time-boxed session button.", "sessionMinutes");
		num("Session length (cards)", "The card-count session button.", "sessionCards");
		new Setting(containerEl)
			.setName("Stop at the end of a session")
			.setDesc("Off: a gentle notice when time is up, and you decide. On: Anki also returns to the deck list.")
			.addToggle((t) =>
				t.setValue(s.hardStop).onChange(async (v) => {
					s.hardStop = v;
					await this.plugin.saveSettings();
				}),
			);
	}
}
