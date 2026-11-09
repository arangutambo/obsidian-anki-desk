import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** The core must stay testable in plain Node: no `obsidian` imports, no Node builtins. */
const CORE = path.resolve(__dirname, "../src/core");

describe("architecture", () => {
	for (const f of readdirSync(CORE).filter((x) => x.endsWith(".ts"))) {
		it(`${f} imports neither obsidian nor node builtins`, () => {
			const src = readFileSync(path.join(CORE, f), "utf8");
			expect(src).not.toMatch(/from\s+["']obsidian["']/);
			expect(src).not.toMatch(/from\s+["'](node:)?(fs|path|child_process|os)["']/);
		});
	}
});
