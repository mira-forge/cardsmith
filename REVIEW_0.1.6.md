# Cardsmith 0.1.6 review (local branch `release-0.1.6`)

Built Oct 26, 2026 (ET). Branch is local only: nothing pushed, tagged, released or deployed. `manifest.json`, `package.json` and `versions.json` are still 0.1.5. No network calls were added.

## What changed

PRO_AUDIT item 4, "Keep this folder in sync".

- `src/core/sync.ts` (new, pure): `classify` (fresh / changed / new / short, using the block hash), `scanNotes` (reads a note only when it has no record or its mtime/size changed), `cleanFolders`, `pendingText`.
- `src/core/history.ts`: `carryHistory` now also returns `unmatched`, the questions of reviewed cards that aren't in the new set. The merge itself is the 0.1.5 logic, unchanged (`mergeBlock` / `upsertBlock` with `keepUnmatched`).
- `src/main.ts`:
  - a status bar count (`.cardsmith-sync-status`), with a click that opens the batch;
  - a check on `onLayoutReady` (Pro only);
  - commands `check-synced-folders` and `refresh-synced-folders`;
  - `refreshSynced` (generate, then one review, then write on approve) and `applySync`. Writes use `vault.process` and `mergeBlock(..., keepUnmatched=true)`, the same path as folder runs;
  - the editor flow passes a `removedFor` callback to `ReviewModal`.
- `src/ui/sync-review-modal.ts` (new): the batch window has per-note and per-card ticks and editable cards, lists the reviewed cards that stay, and has "Approve N notes" and "Cancel". Cancel or Esc writes nothing.
- `src/ui/review-modal.ts`: a live list of the reviewed cards that inserting would remove. The card rendering is shared with the batch window.
- `src/settings.ts`: `syncedFolders`, `syncIndex` and a "Synced folders" row in the Pro section. The row has Add folder, plus a Remove button and a "Folder not found" note for each folder. Free users get "See Pro".
- `src/core/features.ts` and `src/ui/pro-modal.ts`: the `syncFolders` feature and its value-first Pro screen, "Keep this folder in sync", with the free "Try on 5 notes".
- Free gating:
  - free users get no count and no scan;
  - the commands and the settings button open the Pro screen;
  - the 5-note try shares `freeFolderRunUsed` with the folder command and counts as used only after an approval that writes at least 1 note.
- README (Features, SR section, a new "Keep folders in sync (Pro)" how-to, the Free/Pro table, data.json, Vault access, Network use, Files, Which notes) and the `CHANGELOG.md` 0.1.6 draft.

## Results

- `npm test`: **101 passed, 11 files** (was 78 in 10 files; `tests/sync.test.ts` adds 23). The coverage includes:
  - change detection;
  - the startup cost: 200 synced plus 300 other notes give 200 reads on the first check, 0 on an unchanged restart, only the touched notes after edits, and 0 whole-vault listings;
  - approve / reject / Esc, unticking a note, and an edit made during review (it stays "changed");
  - SR history kept byte-identical, with output identical to the 0.1.5 merge;
  - the removed-cards lists;
  - free vs Pro: the 5-note try, shared and used up only on approve, and a lapsed license hiding the count.
- `npm run typecheck`: clean. `npm run lint`: 0 errors, 0 warnings. `npm run build`: OK, main.js 83,279 B, sha256 `a20173578c28…`.
- Real Obsidian 1.14.5 with Spaced Repetition 1.15.4 (headless, fake Ollama, local build):
  - SR regression kit: **OVERALL PASS 20/20**;
  - synced-folder smoke: **OVERALL PASS 34/34**. It covered the status bar count, a first check that read only the 2 Bio notes with 0 whole-vault listings, the batch window listing the reviewed card, Cancel writing nothing, Approve keeping the SR comment byte-identical at the end of the block, an unchanged re-check doing 0 reads, one edited note being the only read, the single-note removed list, and the free Pro screen. Pro was simulated by overriding `isPro` in the test instance only.
  - The proof (screenshots, note snapshots, RESULT.txt, kit files) is in `/workspace/hustler/proof/sync016/`.

## Re-check commands

```bash
cd /workspace/experiments/obsidian-plugin
git checkout release-0.1.6
npm ci && npm test && npm run typecheck && npm run lint && npm run build

# real Obsidian (kit copy that installs the local build; display/ports are free examples)
cd /tmp/cs016-kit   # same files saved at /workspace/hustler/proof/sync016/kit/
CS_LOCAL=/workspace/experiments/obsidian-plugin LEDGER=none CS_TAG=0.1.5 ./run_sr_test.sh /tmp/cs016-recheck-sr :45 9465 18975
CS_LOCAL=/workspace/experiments/obsidian-plugin LEDGER=none CS_TAG=0.1.5 STAGES=stages_sync.mjs ./run_sr_test.sh /tmp/cs016-recheck-sync :46 9466 18976
```

`CS_TAG=0.1.5` is only the label the kit checks against the manifest, which isn't bumped. The kit copy differs from `/workspace/hustler/proof/sr_test_kit` in three ways:
- `CS_LOCAL`, which copies local build files instead of downloading the GitHub release;
- `STAGES`, which picks the stages file;
- the `until` helper ignores exceptions while Obsidian is still loading. Without that, two early runs failed with "app is not defined" before any Cardsmith code ran.

## Known limits

- Mobile doesn't show the status bar, so the two commands are the way in there.
- The count is not live. It updates on startup, on the check command, after adding or removing a folder, and after a refresh.
- No ribbon icon was added for sync. The status bar and commands are the entry points.
- A renamed or moved synced folder has to be added again. Settings shows "Folder not found" for it.
- `data.json` grows by one small entry per note in the synced folders. Entries for notes outside the synced folders are dropped on the next check.
- A file restored with the same mtime and size isn't noticed until it changes again.
- The AI call happens before review, so Cancel still uses the user's API tokens (or local Ollama time) for that batch.
- The `reviewBeforeInsert` setting doesn't apply: a sync batch is always reviewed.
- Notes whose body is shorter than 80 characters are skipped, the same as folder runs.

## Needs Oversight

1. **The README and CHANGELOG edits are local only.** The Stripe hold says no Cardsmith Pro pitches and that the README stays as it is. The 0.1.6 README adds a Synced folders (Pro) feature line, a how-to and a table row. Publish it only when the hold lifts or you OK it.
2. **The site's Cardsmith page** (feature table/pricing copy) doesn't mention synced folders. The site is untouched.
3. **The free taste design** (Try on 5 notes, shared with the one free folder run) needs your OK.
4. **The kit flake fix** (`until` ignoring exceptions) should be ported to the official kit.
5. **0.1.5's Obsidian review scan is still pending.** Ship order is your call: 0.1.6 needs a version bump (manifest, package.json, versions.json), a tag and a release.
