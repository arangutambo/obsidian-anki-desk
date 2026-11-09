/** Prints what the study dashboard would show, from the running Anki. Same core as the plugin. */
import { Anki } from "../src/core/anki";
import { formatMinutes } from "../src/core/dashboard";
import { loadSnapshot } from "../src/core/snapshot";

const arg = (n: string, d: string) => {
	const i = process.argv.indexOf(`--${n}`);
	return i >= 0 ? process.argv[i + 1] : d;
};
const anki = new Anki(async (body) => (await fetch("http://127.0.0.1:8765", { method: "POST", body })).text());

async function main() {
	const t0 = performance.now();
	const s = await loadSnapshot(anki, {
		separateDecks: arg("separate", ""),
		hiddenDecks: arg("hidden", "Custom Study Session"),
		sessionMinutes: 10,
		today: new Date().toLocaleDateString("en-CA"),
		now: Date.now(),
	});
	const total = s.study.reduce((a, r) => a + r.minutes, 0);
	console.log(`Today: ${formatMinutes(total)} of study (${s.reviewedToday} reviewed today)  [loaded in ${(performance.now() - t0).toFixed(0)} ms]`);
	if (s.welcome) console.log(`\n${s.welcome.title}\n${s.welcome.body}`);
	console.log("\nStudy decks:");
	for (const r of [...s.study].sort((a, b) => b.minutes - a.minutes)) console.log(`  ${r.label.padEnd(14)} ${formatMinutes(r.minutes).padEnd(16)} new ${r.newCount}, learning ${r.learn}, review ${r.review}`);
	console.log(`\nOwn time (${formatMinutes(s.separate.reduce((a, r) => a + r.minutes, 0))}):`);
	for (const r of [...s.separate].sort((a, b) => b.minutes - a.minutes)) console.log(`  ${r.label.padEnd(14)} ${formatMinutes(r.minutes).padEnd(16)} new ${r.newCount}, learning ${r.learn}, review ${r.review}`);
	console.log(`\nCards to rewrite: ${s.leeches.length}`);
	for (const l of s.leeches.slice(0, 5)) console.log(`  - ${l.text}  → ${l.file ?? "(no source)"}`);
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
