import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: { alias: { obsidian: path.resolve(__dirname, "test/stubs/obsidian.ts") } },
	test: { environment: "node", include: ["test/**/*.test.ts"], testTimeout: 60_000 },
});
