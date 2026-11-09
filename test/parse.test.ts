import { describe, expect, it } from "vitest";
import { parseCards, formatBlock } from "../src/core/parse";
import { specResolver } from "../src/core/models";

const R = specResolver();

const FILE = `---
tags: [x]
---
# Cards: TEST1000

TARGET DECK: Semester 1 2027::TEST1000

## Probability

START
Basic
Front: What is the likelihood?
Back: P(B|A), read
across lines.
Tags: theme1::prob sheet
<!--ID: 111-->
END

START
Cloze
Text: $P(A|B)$ = {{c1::$P(B|A)P(A)/P(B)$}}
Tags: theme1::prob
END

\`\`\`
START
Basic
Front: this is documentation, not a card
END
\`\`\`

START
Basic (type in the answer)
Front:
- Define a partial agonist
Back:
- never reaches maximal response
<!--ID: 222-->
END
`;

describe("parseCards", () => {
	const p = parseCards(FILE, R);

	it("finds the three real blocks and ignores the one in a code fence", () => {
		expect(p.blocks.map((b) => b.noteType)).toEqual(["Basic", "Cloze", "Basic (type in the answer)"]);
	});

	it("reads deck, heading, fields, tags and ids", () => {
		const [a, b, c] = p.blocks;
		expect(a.deck).toBe("Semester 1 2027::TEST1000");
		expect(a.heading).toBe("Probability");
		expect(a.fields.Back).toBe("P(B|A), read\nacross lines.");
		expect(a.tags).toEqual(["theme1::prob", "sheet"]);
		expect(a.id).toBe(111);
		expect(b.id).toBeNull();
		expect(c.fields.Front).toBe("- Define a partial agonist");
		expect(c.id).toBe(222);
	});

	it("reports duplicate ids and unknown note types", () => {
		const dup = parseCards("START\nBasic\nFront: a\nBack: b\n<!--ID: 1-->\nEND\nSTART\nBasic\nFront: c\nBack: d\n<!--ID: 1-->\nEND\nSTART\nWeird\nFront: x\nEND\n", R);
		expect(dup.problems.map((x) => x.kind).sort()).toEqual(["duplicate-id", "unknown-note-type"]);
	});

	it("TARGET DECK may put the name on the next line", () => {
		expect(parseCards("TARGET DECK\nDeck::Sub\nSTART\nBasic\nFront: a\nBack: b\nEND\n", R).blocks[0].deck).toBe("Deck::Sub");
	});

	it("formatBlock round-trips through the parser", () => {
		const s = formatBlock("Bridge Basic", ["Front", "Back"], { Front: "Q?", Back: "A\nmore" }, ["t1"]);
		const b = parseCards(s, R).blocks[0];
		expect(b.fields).toEqual({ Front: "Q?", Back: "A\nmore" });
		expect(b.tags).toEqual(["t1"]);
	});
});
