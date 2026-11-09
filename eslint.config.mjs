/** Lint against the rules the Obsidian community review runs, plus type-aware TypeScript rules. */
import js from "@eslint/js";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{ ignores: ["main.js", "node_modules/**", "*.cjs", ".*.cjs", "esbuild.config.mjs", "eslint.config.mjs", "vitest.config.ts"] },
	js.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	...obsidianmd.configs.recommended,
	{
		languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
		rules: { "no-undef": "off" },
	},
	{
		// Node scripts and tests never reach main.js.
		files: ["tools/**/*.ts", "test/**/*.ts"],
		rules: {
			"obsidianmd/no-nodejs-modules": "off",
			// Command-line tools print; that is what they are for.
			"no-console": "off",
			"obsidianmd/rule-custom-message": "off",
			"no-restricted-globals": "off",
			"obsidianmd/no-global-this": "off",
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unsafe-argument": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unsafe-return": "off",
		},
	},
);
