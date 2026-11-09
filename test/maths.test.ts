import { describe, expect, it } from "vitest";
import { tokenise, texForAnki } from "../src/core/maths";

const kinds = (s: string) => tokenise(s).segments.map((x) => (x.kind === "math" ? `M(${x.tex})` : x.kind === "code" ? `C(${x.value})` : x.value));

describe("tokenise", () => {
	it("finds inline and display maths", () => {
		expect(kinds("a $x^2$ b $$\\int f$$ c")).toEqual(["a ", "M(x^2)", " b ", "M(\\int f)", " c"]);
	});

	it("regression: `$p = $` never pairs with the next maths (the Obsidian_to_Anki corruption)", () => {
		const t = tokenise("Set $p = $ and then $q$ follows");
		expect(t.segments.filter((s) => s.kind === "math").map((s) => (s as { tex: string }).tex)).toEqual(["q"]);
		expect(t.problems.length).toBeGreaterThan(0);
	});

	it("leaves currency alone", () => {
		const t = tokenise("costs $5 and $10 today");
		expect(t.segments.every((s) => s.kind === "text")).toBe(true);
	});

	it("never treats dollars in code as maths", () => {
		expect(kinds("run `print(\"$\", x)` now $y$")).toEqual(["run ", 'C(`print("$", x)`)', " now ", "M(y)"]);
		const fenced = "```python\nprint('$', a, '$')\n```\nthen $z$";
		expect(kinds(fenced)).toEqual(["C(```python\nprint('$', a, '$')\n```)", "\nthen ", "M(z)"]);
	});

	it("keeps escaped dollars literal", () => {
		expect(tokenise("price \\$5 and $x$").segments.filter((s) => s.kind === "math")).toHaveLength(1);
	});

	it("does not cross a blank line", () => {
		expect(tokenise("$a\n\nb$").segments.some((s) => s.kind === "math")).toBe(false);
	});

	it("splits }} so maths can't close a cloze early", () => {
		expect(texForAnki("\\frac{a}{b}}}")).not.toContain("}}");
	});
});
