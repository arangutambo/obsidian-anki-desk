import { describe, expect, it } from "vitest";
import { EMPTY_STATE, sync, type SyncOptions, type SyncState, type VaultPort } from "../src/core/sync";
import { parseCards } from "../src/core/parse";
import { specResolver } from "../src/core/models";
import { fakeAnki } from "./fake-anki";

const OPTS: SyncOptions = {
	defaultDeck: "Default",
	managedTag: "bridge",
	orphanTag: "bridge::orphan",
	dryRun: false,
	recreateMissing: false,
	keepTags: ["leech", "marked"],
	dropTags: ["Obsidian_to_Anki"],
};

function memVault(files: Record<string, string>): VaultPort & { files: Record<string, string> } {
	return {
		files,
		vaultName: "My Vault",
		listCardFiles: async () => Object.keys(files).map((path) => ({ path, frontmatterDeck: null })),
		read: async (p) => files[p],
		writeIfUnchanged: async (p, expected, next) => {
			if (files[p] !== expected) return false;
			files[p] = next;
			return true;
		},
		readMedia: async () => "aGVsbG8=",
	};
}
function memState() {
	let s: SyncState = structuredClone(EMPTY_STATE);
	return { load: async () => structuredClone(s), save: async (x: SyncState) => void (s = structuredClone(x)), get: () => s };
}

const LEGACY = "TARGET DECK: Course::TEST1000\n## Probability\nSTART\nBasic\nFront: What is $x$?\nBack: a **thing**\nTags: t1\n<!--ID: 42-->\nEND\nSTART\nCloze\nText: net ==2 ATP==\nEND\n";

describe("sync", () => {
	it("adopts a legacy note: converts its type, regenerates fields, swaps tags, keeps its id; creates and writes back new ids", async () => {
		const f = fakeAnki();
		f.seed(42, { modelName: "Basic", fields: { Front: "What is \\(x\\)?<br><a href=\"obsidian://old\">Obsidian</a>", Back: "a <strong>thing</strong>" }, tags: ["Obsidian_to_Anki", "t1", "leech"], deck: "Course::TEST1000" });
		const vault = memVault({ "Cards/TEST1000.md": LEGACY });
		const st = memState();
		const r = await sync(f.anki, vault, st, OPTS);
		expect(r.summary).toMatchObject({ convert: 1, create: 1, orphans: 0 });
		const n42 = f.notes.get(42)!;
		expect(n42.modelName).toBe("Bridge Basic");
		expect(n42.fields.Front).toBe("What is \\(x\\)?");
		expect(n42.fields.Context).toBe("TEST1000 › Probability");
		expect(n42.fields.Source).toContain("obsidian://open?vault=");
		expect(n42.tags.sort()).toEqual(["bridge", "leech", "t1"]);
		const ids = parseCards(vault.files["Cards/TEST1000.md"], specResolver()).blocks.map((b) => b.id);
		expect(ids[0]).toBe(42);
		expect(typeof ids[1]).toBe("number");
		expect(f.notes.get(ids[1]!)!.fields.Text).toBe("net {{c1::2 ATP}}");
		expect(Object.keys(st.get().notes)).toHaveLength(2);
	});

	it("is idempotent: a second sync changes nothing", async () => {
		const f = fakeAnki();
		f.seed(42, { modelName: "Basic", fields: { Front: "x", Back: "y" }, tags: ["Obsidian_to_Anki"], deck: "Course::TEST1000" });
		const vault = memVault({ "a.md": LEGACY });
		await sync(f.anki, vault, memState(), OPTS);
		const r2 = await sync(f.anki, vault, memState(), OPTS);
		expect(r2.summary).toMatchObject({ create: 0, convert: 0, update: 0, unchanged: 2 });
	});

	it("dry run touches nothing", async () => {
		const f = fakeAnki();
		f.seed(42, { modelName: "Basic", fields: { Front: "x", Back: "y" }, tags: [], deck: "D" });
		const vault = memVault({ "a.md": LEGACY });
		const before = JSON.stringify([...f.notes]);
		const r = await sync(f.anki, vault, memState(), { ...OPTS, dryRun: true });
		expect(r.applied).toBeNull();
		expect(JSON.stringify([...f.notes])).toBe(before);
		expect(vault.files["a.md"]).toBe(LEGACY);
	});

	it("never deletes: a note no file mentions any more is tagged as an orphan", async () => {
		const f = fakeAnki();
		f.seed(7, { modelName: "Bridge Basic", fields: { Front: "gone", Back: "" }, tags: ["bridge"], deck: "D" });
		const r = await sync(f.anki, memVault({}), memState(), OPTS);
		expect(r.plan.orphans).toEqual([7]);
		expect(f.notes.get(7)!.tags).toContain("bridge::orphan");
	});

	it("reports IDs that no longer exist in Anki instead of silently recreating them", async () => {
		const f = fakeAnki();
		const r = await sync(f.anki, memVault({ "z.md": "START\nBasic\nFront: a\nBack: b\n<!--ID: 99-->\nEND\n" }), memState(), OPTS);
		expect(r.summary.missing).toBe(1);
		expect(f.notes.size).toBe(0);
	});

	it("if the file changes mid-sync, new ids are still written by matching blocks", async () => {
		const f = fakeAnki();
		const vault = memVault({ "m.md": "START\nBasic\nFront: q\nBack: a\nEND\n" });
		const origWrite = (p: string, e: string, n: string) => vault.files[p] === e ? ((vault.files[p] = n), true) : false;
		let first = true;
		vault.writeIfUnchanged = async (p, e, n) => {
			if (first) {
				first = false;
				vault.files[p] = "edited above\n" + vault.files[p];
				return false;
			}
			return Promise.resolve(origWrite(p, e, n));
		};
		const r = await sync(f.anki, vault, memState(), OPTS);
		expect(r.applied!.idsWritten).toBe(1);
		expect(vault.files["m.md"]).toMatch(/^edited above\nSTART\nBasic\nFront: q\nBack: a\n<!--ID: \d+-->\nEND/);
	});
});
