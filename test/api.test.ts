import { describe, expect, it } from "vitest";
import { ANKI_DESK_API_MEMBERS, ANKI_DESK_API_VERSION, getAnkiDeskApi } from "../src/api-types";

describe("Anki Desk public API v1", () => {
	it("is frozen: changing the members needs a deliberate version bump", () => {
		expect(ANKI_DESK_API_VERSION).toBe("1.0.0");
		expect([...ANKI_DESK_API_MEMBERS]).toEqual(["apiVersion", "dueToday", "ensureDeck", "templates", "draftCard"]);
	});
	it("degrades to null when missing or on another major version", () => {
		const app = (api: unknown) => ({ plugins: { getPlugin: (id: string) => (id === "anki-desk" ? { api } : null) } }) as never;
		expect(getAnkiDeskApi({} as never)).toBeNull();
		expect(getAnkiDeskApi(app({ apiVersion: "2.1.0" }))).toBeNull();
		const v1 = { apiVersion: "1.4.0" };
		expect(getAnkiDeskApi(app(v1))).toBe(v1);
	});
});
