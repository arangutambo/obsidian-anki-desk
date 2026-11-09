# Anki Desk

Write flashcards in your notes; review them in Anki.

- **Incremental, bounded sync.** Only card files are read: notes in your card folders, or notes
  with `anki-deck:` in their frontmatter. The vault is never scanned, and progress is saved after
  every batch, so a large vault costs the same as its card files.
- **Card templates as commands.** *New card: Basic*, *Cloze*, *Sequence*, *Discriminating pair*,
  *Predict the output*, *Explain it*, plus your own templates from one note. Every card opens as a
  draft you can edit, with gentle quality checks, before it's inserted.
- **Maths that survives.** `$…$` and `$$…$$` become Anki's `\(…\)` and `\[…\]` with a real
  tokenizer: dollars in code are never maths, and `$p = $` can't swallow the rest of the card.
- **Never deletes.** A card you remove from your notes is tagged `bridge::orphan` in Anki, not
  deleted.
- **Compatible with Obsidian_to_Anki files.** The same `START`/`END` block syntax and
  `<!--ID: …-->` markers. Existing notes are adopted with their review history intact.

## Card syntax

```
TARGET DECK: Biology::Cells
START
Bridge Basic
Front: What sets the resting membrane potential?
Back: Mostly K⁺ leak through open channels, with the Na⁺/K⁺-ATPase keeping gradients.
Tags: physiology
END
```

Note types (named "Bridge" because each one bridges a card and its note): `Bridge Basic` (Front, Back), `Bridge Cloze` (Text, Back Extra), `Bridge Type`
(Front, typed Back). The legacy names `Basic`, `Cloze` and `Basic (type in the answer)` are read as
these. Every Bridge note type also carries **Context** (a breadcrumb, shown small above the
question) and **Source** (a link back to the note, shown under the answer). Both are generated.

## Your own templates

Put fenced blocks in the note named in settings (default `Anki Desk Templates.md`):

````
```anki-template
id: drug
label: Drug card
type: Bridge Basic
Front: {{selection.firstLine}}: mechanism, key adverse effects, one interaction?
Back: {{selection.rest}}
tags: pharm
```
````

Placeholders: `{{selection}}`, `{{selection.firstLine}}`, `{{selection.rest}}`, `{{heading}}`,
`{{note}}`, `{{deck}}`. A template with a built-in id replaces the built-in.

## Requirements and disclosures

- Desktop Anki with the **AnkiConnect** add-on. Syncing is desktop-only; writing cards works on
  mobile and syncs next time.
- **Network:** the plugin talks only to AnkiConnect on your own computer
  (`http://127.0.0.1:8765` by default). Nothing is sent anywhere else. No telemetry.
- Writes to your vault only to insert `<!--ID: …-->` markers into card blocks it has just created
  in Anki, and only if the file hasn't changed since it was read.

## Development

```bash
npm install
npm test          # pure core, including a synthetic 8,640-note vault performance test
npm run build     # main.js
npm run cli -- --vault "/path/to/vault"            # preview sync outside Obsidian
npm run cli -- --vault "/path/to/vault" --apply    # sync outside Obsidian
```

MIT licence.
