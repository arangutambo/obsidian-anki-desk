/**
 * Sync orchestration, shared by the Obsidian plugin and the CLI. Everything environmental
 * (files, media, state, Anki) is injected, so this stays pure and testable.
 *
 * Memory discipline (the reason this plugin exists): only card files are read, one at a time;
 * per file we keep just the desired notes. State is persisted after every batch, so a crash
 * mid-sync never means redoing finished work.
 */

import { Anki, fetchNotes } from "./anki";
import { desiredNote, type DesiredNote } from "./card";
import { CSS, MODELS, allFields, type BridgeModel } from "./models";
import { parseCards, type ParseProblem } from "./parse";
import { specResolver } from "./models";
import { plan as makePlan, finalTags, summarise, type Plan, type PlanItem, type PlanOptions } from "./plan";
import { applyIds, type IdWrite } from "./writeback";

export interface CardFile {
	path: string;
	frontmatterDeck: string | null;
}

export interface VaultPort {
	vaultName: string;
	listCardFiles(): Promise<CardFile[]>;
	read(path: string): Promise<string>;
	/** Writes only if the file still equals `expected`; returns false otherwise. */
	writeIfUnchanged(path: string, expected: string, next: string): Promise<boolean>;
	/** Base64 of a linked media file, or null if it can't be resolved. */
	readMedia(target: string, fromPath: string): Promise<string | null>;
}

export interface SyncState {
	version: 1;
	/** note id → hash of the last state written to Anki. */
	notes: Record<string, string>;
	lastSync: string | null;
}

export interface StatePort {
	load(): Promise<SyncState>;
	save(s: SyncState): Promise<void>;
}

export interface SyncOptions extends PlanOptions {
	defaultDeck: string;
	managedTag: string;
	/** Tag put on Anki notes that no file references any more. */
	orphanTag: string;
	dryRun: boolean;
	aliases?: Record<string, string>;
	log?: (msg: string) => void;
}

export interface FileReport {
	path: string;
	blocks: number;
	problems: ParseProblem[];
	lintDollarCards: number;
}

export interface SyncReport {
	files: FileReport[];
	plan: Plan;
	summary: Record<string, number>;
	applied: { created: number; converted: number; updated: number; idsWritten: number; orphansTagged: number; failures: string[] } | null;
}

export const EMPTY_STATE: SyncState = { version: 1, notes: {}, lastSync: null };

export async function sync(anki: Anki, vault: VaultPort, state: StatePort, opts: SyncOptions): Promise<SyncReport> {
	const log = opts.log ?? (() => {});
	const resolver = specResolver(opts.aliases);
	const fileReports: FileReport[] = [];
	const perFile: { path: string; content: string; notes: DesiredNote[] }[] = [];

	for (const f of await vault.listCardFiles()) {
		const content = await vault.read(f.path);
		const parsed = parseCards(content, resolver);
		const notes: DesiredNote[] = [];
		let dollar = 0;
		for (const b of parsed.blocks) {
			const n = desiredNote(b, {
				vaultName: vault.vaultName,
				path: f.path,
				frontmatterDeck: f.frontmatterDeck,
				defaultDeck: opts.defaultDeck,
				fileTags: parsed.fileTags,
				managedTag: opts.managedTag,
				aliases: opts.aliases,
			});
			if (!n) continue;
			if (n.problems.length) dollar++;
			notes.push(n);
		}
		fileReports.push({ path: f.path, blocks: parsed.blocks.length, problems: parsed.problems, lintDollarCards: dollar });
		perFile.push({ path: f.path, content, notes });
	}

	const ids = perFile.flatMap((f) => f.notes.map((n) => n.block.id).filter((x): x is number => x !== null));
	const current = await fetchNotes(anki, [...new Set(ids)]);
	const managedQuery = [opts.managedTag, ...opts.dropTags].map((t) => `tag:${t}`).join(" OR ");
	const managedIds = await anki.call<number[]>("findNotes", { query: managedQuery });
	const p = makePlan(
		perFile.map((f) => ({ path: f.path, notes: f.notes })),
		current,
		managedIds,
		opts,
	);
	const report: SyncReport = { files: fileReports, plan: p, summary: summarise(p), applied: null };
	log(`plan: ${JSON.stringify(report.summary)}`);
	if (opts.dryRun) return report;

	const st = await state.load();
	const applied = { created: 0, converted: 0, updated: 0, idsWritten: 0, orphansTagged: 0, failures: [] as string[] };
	const persist = async () => {
		st.lastSync = new Date().toISOString();
		await state.save(st);
	};

	await ensureModels(anki, log);
	await ensureDecks(anki, [...new Set(p.items.map((i) => i.note.deck))]);
	await uploadMedia(anki, vault, p.items, log);

	// Creates (and recreations): addNote, then write IDs back per file.
	const creates = p.items.filter((i): i is Extract<PlanItem, { kind: "create" }> => i.kind === "create");
	const createRes = await anki.multi(
		creates.map((c) => ({
			action: "addNote",
			params: {
				note: {
					deckName: c.note.deck,
					modelName: c.note.model.name,
					fields: c.note.fields,
					tags: c.note.tags,
					options: { allowDuplicate: true },
				},
			},
		})),
		50,
		persist,
	);
	const writesByFile = new Map<string, IdWrite[]>();
	createRes.forEach((r, k) => {
		const c = creates[k];
		if (r instanceof Error || typeof r !== "number") {
			applied.failures.push(`${c.file}:${c.note.block.line} add failed: ${String(r)}`);
			return;
		}
		applied.created++;
		st.notes[String(r)] = c.note.hash;
		if (!writesByFile.has(c.file)) writesByFile.set(c.file, []);
		writesByFile.get(c.file)!.push({ block: c.note.block, id: r });
	});
	await persist();
	for (const f of perFile) {
		const writes = writesByFile.get(f.path);
		if (!writes?.length) continue;
		if (await vault.writeIfUnchanged(f.path, f.content, applyIds(f.content, writes))) {
			applied.idsWritten += writes.length;
			continue;
		}
		// The file changed while Anki was being updated. The notes now exist in Anki, so the IDs
		// must still land or the next sync would create duplicates: re-parse and match each new
		// note to its block by content.
		const fresh = await vault.read(f.path);
		const blocks = parseCards(fresh, resolver).blocks.filter((b) => b.id === null);
		const rematched: IdWrite[] = [];
		for (const w of writes) {
			const key = JSON.stringify([w.block.noteType, w.block.fields]);
			const b = blocks.find((x) => JSON.stringify([x.noteType, x.fields]) === key && !rematched.some((r) => r.block === x));
			if (b) rematched.push({ block: b, id: w.id });
			else applied.failures.push(`${f.path}:${w.block.line} note ${w.id} was created but its block changed; add <!--ID: ${w.id}--> by hand`);
		}
		if (rematched.length && (await vault.writeIfUnchanged(f.path, fresh, applyIds(fresh, rematched)))) applied.idsWritten += rematched.length;
	}

	// Converts: legacy note type → Bridge type, keeping card ids and history.
	const converts = p.items.filter((i): i is Extract<PlanItem, { kind: "convert" }> => i.kind === "convert");
	const convRes = await anki.multi(
		converts.map((c) => ({
			action: "updateNoteModel",
			params: {
				note: {
					id: c.id,
					modelName: c.note.model.name,
					fields: c.note.fields,
					tags: finalTags(current.get(c.id)?.tags ?? [], c.note.tags, opts),
				},
			},
		})),
		50,
		persist,
	);
	convRes.forEach((r, k) => {
		const c = converts[k];
		if (r instanceof Error) applied.failures.push(`${c.file}:${c.note.block.line} convert ${c.id} failed: ${r.message}`);
		else {
			applied.converted++;
			st.notes[String(c.id)] = c.note.hash;
		}
	});
	await persist();

	// Updates: fields and tags, then decks.
	const updates = p.items.filter((i): i is Extract<PlanItem, { kind: "update" }> => i.kind === "update");
	const updActions = updates.flatMap((u) => {
		const acts: { action: string; params: Record<string, unknown> }[] = [];
		if (u.fields) acts.push({ action: "updateNoteFields", params: { note: { id: u.id, fields: u.note.fields } } });
		if (u.tags) acts.push({ action: "updateNoteTags", params: { note: u.id, tags: finalTags(current.get(u.id)?.tags ?? [], u.note.tags, opts) } });
		return acts;
	});
	const updRes = await anki.multi(updActions, 50, persist);
	updRes.forEach((r) => {
		if (r instanceof Error) applied.failures.push(`update failed: ${r.message}`);
	});

	// Deck moves for converts and updates.
	const moves = new Map<string, number[]>();
	for (const it of [...converts, ...updates]) {
		const cur = current.get(it.id);
		if (!cur || (cur.decks.length === 1 && cur.decks[0] === it.note.deck)) continue;
		if (!moves.has(it.note.deck)) moves.set(it.note.deck, []);
		moves.get(it.note.deck)!.push(...cur.cards);
	}
	for (const [deck, cards] of moves) await anki.call("changeDeck", { cards, deck });
	for (const u of updates) {
		applied.updated++;
		st.notes[String(u.id)] = u.note.hash;
	}
	await persist();

	if (p.orphans.length) {
		await anki.call("addTags", { notes: p.orphans, tags: opts.orphanTag });
		applied.orphansTagged = p.orphans.length;
	}
	await persist();
	report.applied = applied;
	return report;
}

export async function ensureModels(anki: Anki, log: (m: string) => void = () => {}): Promise<void> {
	const existing = new Set(await anki.call<string[]>("modelNames"));
	for (const m of MODELS) {
		if (existing.has(m.name)) {
			await updateModel(anki, m);
			continue;
		}
		await anki.call("createModel", {
			modelName: m.name,
			inOrderFields: allFields(m),
			css: CSS,
			isCloze: m.isCloze,
			cardTemplates: m.templates,
		});
		log(`created note type ${m.name}`);
	}
}

async function updateModel(anki: Anki, m: BridgeModel): Promise<void> {
	const templates = Object.fromEntries(m.templates.map((t) => [t.Name, { Front: t.Front, Back: t.Back }]));
	await anki.call("updateModelTemplates", { model: { name: m.name, templates } });
	await anki.call("updateModelStyling", { model: { name: m.name, css: CSS } });
}

export async function ensureDecks(anki: Anki, decks: string[]): Promise<void> {
	const existing = new Set(await anki.call<string[]>("deckNames"));
	for (const d of decks) if (!existing.has(d)) await anki.call("createDeck", { deck: d });
}

async function uploadMedia(anki: Anki, vault: VaultPort, items: PlanItem[], log: (m: string) => void): Promise<void> {
	const wanted = new Map<string, { target: string; from: string }>();
	for (const it of items) {
		if (it.kind === "unchanged" || it.kind === "missing" || it.kind === "duplicate") continue;
		for (const m of it.note.media) wanted.set(m.ankiName, { target: m.target, from: it.file });
	}
	if (!wanted.size) return;
	const have = new Set(await anki.call<string[]>("getMediaFilesNames", { pattern: "*" }));
	for (const [name, { target, from }] of wanted) {
		if (have.has(name)) continue;
		const data = await vault.readMedia(target, from);
		if (!data) {
			log(`media not found: ${target} (from ${from})`);
			continue;
		}
		await anki.call("storeMediaFile", { filename: name, data });
	}
}
