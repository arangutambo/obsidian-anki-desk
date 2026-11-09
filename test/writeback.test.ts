import { describe, expect, it } from "vitest";
import { parseCards } from "../src/core/parse";
import { specResolver } from "../src/core/models";
import { applyIds } from "../src/core/writeback";

const R = specResolver();

describe("applyIds", () => {
	it("inserts markers before END and replaces existing ones, touching nothing else", () => {
		const src = "intro\nSTART\nBasic\nFront: a\nBack: b\nEND\n\nmiddle\nSTART\nBasic\nFront: c\nBack: d\n<!--ID: 5-->\nEND\noutro\n";
		const [b1, b2] = parseCards(src, R).blocks;
		const out = applyIds(src, [{ block: b1, id: 101 }, { block: b2, id: 202 }]);
		expect(out).toBe("intro\nSTART\nBasic\nFront: a\nBack: b\n<!--ID: 101-->\nEND\n\nmiddle\nSTART\nBasic\nFront: c\nBack: d\n<!--ID: 202-->\nEND\noutro\n");
		const again = parseCards(out, R).blocks.map((b) => b.id);
		expect(again).toEqual([101, 202]);
	});
});
