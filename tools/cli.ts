/**
 * Runs the sync core against a real vault and a running Anki, outside Obsidian.
 *
 *   npm run cli -- --vault "/path/to/vault"            # dry run (default): report only
 *   npm run cli -- --vault "/path/to/vault" --apply    # adopt / sync for real
 *
 * Options:
 *   --folders pages/Anki      card folders (comma-separated)
 *   --include a.md,b.md       extra card files (vault-relative)
 *   --report reports/x.md     where to write the markdown report
 *   --recreate-missing        re-create notes whose ID is gone from Anki (new IDs written back)
 *
 * Reading the vault: walks it once to find card files by folder or frontmatter (`anki-deck:`
 * or `anki: true`), reading only the first 2 KB of each note, and records attachment names for
 * media lookup. The plugin itself never walks the vault; it asks Obsidian's metadata cache.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { Anki } from "../src/core/anki";
import { EMPTY_STATE, sync, type CardFile, type SyncState, type VaultPort } from "../src/core/sync";
import { textLength } from "../src/core/render";

function arg(name: string, fallback?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	if (i < 0) return fallback;
	const v = process.argv[i + 1];
	return v && !v.startsWith("--") ? v : "true";
}

const VAULT_ARG = arg("vault");
if (!VAULT_ARG || VAULT_ARG === "true") {
	console.error("Usage: npm run cli -- --vault \"/path/to/vault\" [--apply]");
	process.exit(2);
}
const VAULT: string = VAULT_ARG;
const APPLY = arg("apply") === "true";
const FOLDERS = (arg("folders", "pages/Anki") ?? "").split(",").filter(Boolean);
const INCLUDE = (arg("include", "") ?? "").split(",").filter(Boolean);
const REPORT = arg("report", `reports/${APPLY ? "sync" : "dry-run"}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`)!;
const RECREATE = arg("recreate-missing") === "true";
const IGNORE = [/^\.obsidian\//, /^\.trash\//, /^Sources\//, /^pages\/Readwise\//, /^pages\/Zotero\//, /\.excalidraw\.md$/];

async function walk(root: string): Promise<{ md: string[]; attachments: Map<string, string> }> {
	const md: string[] = [];
	const attachments = new Map<string, string>();
	const stack = [""];
	while (stack.length) {
		const rel = stack.pop()!;
		for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.name.startsWith(".") && e.isDirectory()) continue;
			if (e.isDirectory()) stack.push(r);
			else if (r.endsWith(".md")) md.push(r);
			else if (!attachments.has(e.name)) attachments.set(e.name, r);
		}
	}
	return { md, attachments };
}

async function head(file: string, bytes = 2048): Promise<string> {
	const h = await fs.open(file, "r");
	try {
		const buf = Buffer.alloc(bytes);
		const { bytesRead } = await h.read(buf, 0, bytes, 0);
		return buf.subarray(0, bytesRead).toString("utf8");
	} finally {
		await h.close();
	}
}

function frontmatterDeck(text: string): { isCard: boolean; deck: string | null } {
	const m = /^---\n([\s\S]*?)\n---/.exec(text);
	if (!m) return { isCard: false, deck: null };
	const deck = /^anki-deck:\s*["']?(.+?)["']?\s*$/m.exec(m[1])?.[1] ?? null;
	const flag = /^anki:\s*true\s*$/m.test(m[1]);
	return { isCard: !!deck || flag, deck };
}

async function main() {
	const t0 = performance.now();
	const { md, attachments } = await walk(VAULT);
	const cardFiles: CardFile[] = [];
	for (const rel of md) {
		if (IGNORE.some((r) => r.test(rel))) continue;
		const inFolder = FOLDERS.some((f) => rel.startsWith(f.replace(/\/?$/, "/")));
		const included = INCLUDE.includes(rel);
		const fm = frontmatterDeck(await head(path.join(VAULT, rel)));
		if (inFolder || included || fm.isCard) cardFiles.push({ path: rel, frontmatterDeck: fm.deck });
	}
	const walkMs = performance.now() - t0;

	const anki = new Anki(async (body) => {
		const r = await fetch("http://127.0.0.1:8765", { method: "POST", body });
		return r.text();
	});
	const vault: VaultPort = {
		vaultName: path.basename(VAULT),
		listCardFiles: async () => cardFiles,
		read: (p) => fs.readFile(path.join(VAULT, p), "utf8"),
		writeIfUnchanged: async (p, expected, next) => {
			const now = await fs.readFile(path.join(VAULT, p), "utf8");
			if (now !== expected) return false;
			await fs.writeFile(path.join(VAULT, p), next, "utf8");
			return true;
		},
		readMedia: async (target) => {
			const name = target.split("/").pop()!;
			const rel = attachments.get(name);
			if (!rel) return null;
			return (await fs.readFile(path.join(VAULT, rel))).toString("base64");
		},
	};
	const statePath = path.resolve(".state/state.json");
	const state = {
		load: async (): Promise<SyncState> => {
			try {
				return JSON.parse(await fs.readFile(statePath, "utf8"));
			} catch {
				return structuredClone(EMPTY_STATE);
			}
		},
		save: async (s: SyncState) => {
			await fs.mkdir(path.dirname(statePath), { recursive: true });
			await fs.writeFile(statePath, JSON.stringify(s, null, 1));
		},
	};

	const heap0 = process.memoryUsage().heapUsed;
	const r = await sync(anki, vault, state, {
		defaultDeck: "Default",
		managedTag: "bridge",
		orphanTag: "bridge::orphan",
		dryRun: !APPLY,
		recreateMissing: RECREATE,
		keepTags: ["leech", "marked"],
		dropTags: ["Obsidian_to_Anki"],
		log: (m) => console.log(m),
	});
	const syncMs = performance.now() - t0 - walkMs;
	const heapMb = (process.memoryUsage().heapUsed - heap0) / 1e6;

	const lines: string[] = [];
	lines.push(`# Anki Desk ${APPLY ? "sync" : "dry run"} — ${new Date().toISOString()}`, "");
	lines.push(`Vault: \`${VAULT}\` — ${md.length} markdown files walked in ${walkMs.toFixed(0)} ms; ${cardFiles.length} card files.`);
	lines.push(`Sync core: ${syncMs.toFixed(0)} ms, heap +${heapMb.toFixed(1)} MB.`, "");
	lines.push("## Summary", "", "| | count |", "| --- | --- |");
	for (const [k, v] of Object.entries(r.summary)) lines.push(`| ${k} | ${v} |`);
	if (r.applied) {
		lines.push("", "## Applied", "", "```json", JSON.stringify(r.applied, null, 1), "```");
	}
	lines.push("", "## Files", "", "| file | blocks | problems | cards with unpaired $ |", "| --- | --- | --- | --- |");
	for (const f of r.files) lines.push(`| ${f.path} | ${f.blocks} | ${f.problems.map((p) => `${p.kind}@${p.line} ${p.detail}`).join("; ")} | ${f.lintDollarCards} |`);
	const byKind = (k: string) => r.plan.items.filter((i) => i.kind === k);
	const missing = byKind("missing");
	if (missing.length) {
		lines.push("", "## IDs in files that no longer exist in Anki", "");
		const per = new Map<string, number>();
		for (const m of missing) per.set(m.file, (per.get(m.file) ?? 0) + 1);
		for (const [f, n] of per) lines.push(`- ${f}: ${n}`);
	}
	for (const k of ["duplicate", "create"]) {
		const xs = byKind(k);
		if (!xs.length) continue;
		lines.push("", `## ${k}`, "");
		for (const x of xs.slice(0, 40)) lines.push(`- ${x.file}:${x.note.block.line} → ${x.note.deck}`);
	}
	const samples = [...byKind("convert"), ...byKind("update")].slice(0, 6);
	if (samples.length) {
		lines.push("", "## Sample field changes", "");
		const cur = new Map<number, Record<string, string>>();
		for (const s of samples) {
			if (!("id" in s)) continue;
			const info = await anki.call<{ fields: Record<string, { value: string }> }[]>("notesInfo", { notes: [s.id] });
			cur.set(s.id, Object.fromEntries(Object.entries(info[0]?.fields ?? {}).map(([k, v]) => [k, v.value])));
		}
		for (const s of samples) {
			if (!("id" in s)) continue;
			lines.push(`### ${s.file}:${s.note.block.line} (note ${s.id}, ${s.kind})`, "");
			for (const [k, v] of Object.entries(s.note.fields)) {
				const before = cur.get(s.id)?.[k] ?? "(none)";
				if (before === v) continue;
				lines.push(`- **${k}** before: \`${before.slice(0, 220).replace(/`/g, "'")}\``);
				lines.push(`- **${k}** after: \`${v.slice(0, 220).replace(/`/g, "'")}\``);
			}
			lines.push("");
		}
	}
	const passages = r.plan.items.filter((i) => textLength(i.note.fields.Back ?? i.note.fields["Back Extra"] ?? "") > 350).length;
	lines.push("", `Cards whose answer is longer than 350 characters (passage lint): ${passages}.`);
	await fs.mkdir(path.dirname(REPORT), { recursive: true });
	await fs.writeFile(REPORT, lines.join("\n"));
	console.log(`report → ${REPORT}`);
	console.log(JSON.stringify(r.summary));
	if (r.applied) console.log(JSON.stringify(r.applied));
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
