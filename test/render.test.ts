import { describe, expect, it } from "vitest";
import { renderField } from "../src/core/render";

describe("renderField", () => {
	it("emits Anki MathJax delimiters", () => {
		expect(renderField("Bayes: $P(A|B)$ and $$x^2$$", { cloze: false }).html).toBe("Bayes: \\(P(A|B)\\) and \\[x^2\\]");
	});

	it("keeps clozes and maths inside them intact", () => {
		expect(renderField("{{c1::$2p(1-p)$}} at p = {{c2::0.5}}", { cloze: true }).html).toBe("{{c1::\\(2p(1-p)\\)}} at p = {{c2::0.5}}");
	});

	it("turns ==highlights== into the next clozes, but not Python's ==", () => {
		expect(renderField("{{c1::a}} and ==b== then `x == y`", { cloze: true }).html).toBe("{{c1::a}} and {{c2::b}} then <code>x == y</code>");
		expect(renderField("if a == b", { cloze: true }).html).toBe("if a == b");
	});

	it("renders markdown: bold, lists, code blocks", () => {
		expect(renderField("**bold** text", { cloze: false }).html).toBe("<strong>bold</strong> text");
		expect(renderField("- one\n- two", { cloze: false }).html).toContain("<li>one</li>");
		expect(renderField("```python\nprint(1)\n```", { cloze: false }).html).toContain("<pre><code");
	});

	it("dollars in code survive untouched (a real corruption the old plugin caused)", () => {
		const r = renderField("`print(\"Tax payable is $\", tax, sep='')`", { cloze: false });
		expect(r.html).toContain("$");
		expect(r.html).not.toContain("\\(");
	});

	it("wiki images become <img> and are reported for upload; wiki links become text", () => {
		const r = renderField("see ![[Assets/heart diagram.png|300]] and [[Cardiac cycle|the cycle]]", { cloze: false });
		expect(r.html).toContain('<img src="heart diagram.png">');
		expect(r.html).toContain("the cycle");
		expect(r.media).toEqual([{ target: "Assets/heart diagram.png", ankiName: "heart diagram.png" }]);
	});
});
