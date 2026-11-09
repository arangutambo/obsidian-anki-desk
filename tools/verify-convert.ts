/**
 * Creates the Bridge note types, then proves on a throwaway note that `updateNoteModel`
 * keeps the card id, its scheduling and its review log. Cleans up after itself.
 */
import { Anki } from "../src/core/anki";
import { ensureModels } from "../src/core/sync";

const anki = new Anki(async (body) => (await fetch("http://127.0.0.1:8765", { method: "POST", body })).text());
const DECK = "ZZ Anki Desk self-test";

async function main() {
	await ensureModels(anki, console.log);
	await anki.call("createDeck", { deck: DECK });
	const nid = await anki.call<number>("addNote", {
		note: { deckName: DECK, modelName: "Basic", fields: { Front: "self-test front", Back: "self-test back" }, tags: ["bridge-selftest"], options: { allowDuplicate: true } },
	});
	const [cid] = (await anki.call<{ cards: number[] }[]>("notesInfo", { notes: [nid] }))[0].cards;
	await anki.call("answerCards", { answers: [{ cardId: cid, ease: 3 }] });
	await anki.call("answerCards", { answers: [{ cardId: cid, ease: 3 }] });
	const before = (await anki.call<any[]>("cardsInfo", { cards: [cid] }))[0];
	const revBefore = await anki.call<Record<string, unknown[]>>("getReviewsOfCards", { cards: [cid] });
	await anki.call("updateNoteModel", {
		note: { id: nid, modelName: "Bridge Basic", fields: { Front: "self-test front", Back: "self-test back", Context: "TEST › self", Source: "obsidian://open?vault=x&file=y" }, tags: ["bridge-selftest"] },
	});
	const info = (await anki.call<any[]>("notesInfo", { notes: [nid] }))[0];
	const after = (await anki.call<any[]>("cardsInfo", { cards: info.cards }))[0];
	const revAfter = await anki.call<Record<string, unknown[]>>("getReviewsOfCards", { cards: [after.cardId] });
	const ok =
		info.modelName === "Bridge Basic" &&
		after.cardId === cid &&
		after.reps === before.reps &&
		after.interval === before.interval &&
		after.due === before.due &&
		(revAfter[String(cid)] ?? []).length === (revBefore[String(cid)] ?? []).length &&
		after.question.includes("self-test front") &&
		after.question.includes("TEST › self");
	console.log(JSON.stringify({ model: info.modelName, cardBefore: cid, cardAfter: after.cardId, reps: [before.reps, after.reps], interval: [before.interval, after.interval], due: [before.due, after.due], reviews: [(revBefore[String(cid)] ?? []).length, (revAfter[String(cid)] ?? []).length], rendersContext: after.question.includes("TEST › self") }));
	await anki.call("deleteNotes", { notes: [nid] });
	await anki.call("deleteDecks", { decks: [DECK], cardsToo: true });
	console.log(ok ? "PASS: conversion keeps card id, scheduling and review log" : "FAIL");
	process.exit(ok ? 0 : 1);
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
