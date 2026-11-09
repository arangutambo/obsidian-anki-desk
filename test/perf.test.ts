import { describe, expect, it } from "vitest";
import { parseCards } from "../src/core/parse";
import { specResolver } from "../src/core/models";
import { desiredNote } from "../src/core/card";

/**
 * The failure that started this plugin: memory grew with files *scanned*. Here only card
 * files are parsed, so an 8,640-file vault costs the same as its 35 card files. This test
 * builds that vault in memory and checks time and heap for the work sync actually does.
 */
describe("performance at real-vault scale", () => {
	it("parses and renders 35 card files (≈1,000 cards) among 8,640 notes under budget", () => {
		const R = specResolver();
		const card = (i: number) => `START\nBasic\nFront: Question ${i} with $x_${i}^2$ and **bold**\nBack: Answer ${i}\n- a\n- b\nTags: t${i % 7}\n<!--ID: ${1e12 + i}-->\nEND\n`;
		const cloze = (i: number) => `START\nCloze\nText: Fact ${i} is {{c1::$\\frac{a}{b}$}} and ==${i}==\nEND\n`;
		const vault: { path: string; content: string; isCard: boolean }[] = [];
		for (let f = 0; f < 8640; f++) {
			const isCard = f % 247 === 0; // 35 card files
			const content = isCard
				? `TARGET DECK: Deck::F${f}\n## H\n` + Array.from({ length: 29 }, (_, i) => (i % 4 ? card(f * 100 + i) : cloze(f * 100 + i))).join("\n")
				: `# Note ${f}\n` + "Lorem ipsum dolor sit amet. ".repeat(40);
			vault.push({ path: `pages/n${f}.md`, content, isCard });
		}
		if (global.gc) global.gc();
		const heap0 = process.memoryUsage().heapUsed;
		const t0 = performance.now();
		let notes = 0;
		for (const f of vault.filter((x) => x.isCard)) {
			for (const b of parseCards(f.content, R).blocks) {
				const n = desiredNote(b, { vaultName: "V", path: f.path, frontmatterDeck: null, defaultDeck: "Default", fileTags: [], managedTag: "bridge" });
				if (n) notes++;
			}
		}
		const ms = performance.now() - t0;
		const mb = (process.memoryUsage().heapUsed - heap0) / 1e6;
		console.log(`card files: 35, notes: ${notes}, ${ms.toFixed(0)} ms, heap +${mb.toFixed(1)} MB`);
		expect(notes).toBe(35 * 29);
		expect(ms).toBeLessThan(5000);
		expect(mb).toBeLessThan(150);
	});
});
