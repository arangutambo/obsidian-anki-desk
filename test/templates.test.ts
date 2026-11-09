import { describe, expect, it } from "vitest";
import { BUILTINS, mergeTemplates, parseTemplates } from "../src/core/templates";

const ctx = { selection: "", heading: "Glycolysis", note: "Metabolism", deck: "Medicine::Biochem" };
const get = (id: string) => BUILTINS.find((t) => t.id === id)!;

describe("built-in templates", () => {
	it("basic splits first line from the rest", () => {
		expect(get("basic").make({ ...ctx, selection: "Q?\nA line\nanother" }).fields).toEqual({ Front: "Q?", Back: "A line\nanother" });
	});
	it("cloze wraps a plain selection, keeps highlights", () => {
		expect(get("cloze").make({ ...ctx, selection: "ATP" }).fields.Text).toBe("{{c1::ATP}}");
		expect(get("cloze").make({ ...ctx, selection: "net ==2 ATP==" }).fields.Text).toBe("net ==2 ATP==");
	});
	it("sequence makes one deletion per step", () => {
		const t = get("sequence").make({ ...ctx, selection: "1. hexokinase\n2. PGI\n3. PFK-1" }).fields.Text;
		expect(t).toContain("{{c1::hexokinase}}");
		expect(t).toContain("{{c3::PFK-1}}");
		expect(t.startsWith("Glycolysis:")).toBe(true);
	});
	it("pair asks to discriminate", () => {
		expect(get("pair").make({ ...ctx, selection: "BLUP vs GBLUP\nGBLUP uses markers" }).fields.Front).toBe(
			"When would you choose BLUP rather than GBLUP, and why?",
		);
	});
	it("explain asks for whole-topic recall from the heading", () => {
		expect(get("explain").make({ ...ctx, selection: "the section" }).fields.Front).toContain("**Glycolysis**");
	});
});

describe("vault templates", () => {
	const note = "Some prose\n```anki-template\nid: drug\nlabel: Drug card\ntype: Bridge Basic\nFront: {{selection.firstLine}}: mechanism?\nBack: {{selection.rest}}\n  (check {{deck}})\ntags: pharm\n```\n```anki-template\nid: basic\nlabel: My basic\ntype: Bridge Basic\nFront: Q: {{selection}}\nBack:\n```\n```anki-template\nid: bad\ntype: Nope\n```";
	const { templates, errors } = parseTemplates(note, "Anki Desk Templates.md");

	it("parses fields, placeholders and tags", () => {
		const d = templates.find((t) => t.id === "drug")!.make({ ...ctx, selection: "Metformin\nActivates AMPK" });
		expect(d.fields.Front).toBe("Metformin: mechanism?");
		expect(d.fields.Back).toBe("Activates AMPK\n  (check Medicine::Biochem)");
		expect(d.tags).toEqual(["pharm"]);
	});
	it("reports bad blocks instead of throwing", () => {
		expect(errors).toEqual(['Anki Desk Templates.md: unknown type "Nope"']);
	});
	it("vault templates override built-ins by id; disabled ones disappear", () => {
		const merged = mergeTemplates(BUILTINS, templates, ["predict"]);
		expect(merged.find((t) => t.id === "basic")!.label).toBe("My basic");
		expect(merged.some((t) => t.id === "predict")).toBe(false);
		expect(merged.some((t) => t.id === "drug")).toBe(true);
	});
});
