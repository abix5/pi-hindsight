# Slice 6 — README, CHANGELOG, release 0.6.0

Parent plan: `PLAN.md` (approved). Order: **last**; needs slices 1–5 merged.
This slice ships nothing new — it makes what shipped explainable and
announces it once.

## WHAT and WHY

Three user-visible changes need words: the two-memory contract (what goes
where and why), `hindsight_recall` as a delegation to a librarian (what the
person sees while it runs and after), and the `autoRecall` migration (their
`true`/`false` keeps working; the new default only applies to fresh installs).
The CHANGELOG entry is mandatory: the extension shows it once after the
upgrade (`src/changelog.ts`, bank rule).

## ALREADY DONE — do not re-verify

- The changelog notice mechanism ships and is tested
  (`scripts/changelog.test.ts`); `CHANGELOG.md` is in `package.json` `files`.
- README is part of the checked interface: `widget.test.ts`,
  `recall-block.test.ts`, `review-queue.test.ts`,
  `restore-killed-fact.test.ts`, `user-bank-context.test.ts` assert exact
  wording. Slice 1 already updated the recall-block examples.
- Screenshots: `make shots` (vhs; `docs/shots.tape`); images referenced by
  absolute `raw.githubusercontent.com` URLs.

## Specification

### Requirement: README sections

README SHALL gain or update, in this order and with these headings:

- `## Two banks` — project vs user, the one-sentence test, which tool writes
  where, how the agent is told (the `## Memory` instruction), how to enable
  the user bank (`userBankId`).
- `## Asking memory` — `hindsight_recall` is a delegation; what the Working…
  line shows; what the result block shows; that steps live in `/mem` → Log.
- The settings table row for `autoRecall` — three values, migration note.
- `## The recall block` examples already carry the `[bank · date · type ·
  tags]` lines (slice 1); verify, do not rewrite.

### Requirement: CHANGELOG 0.6.0

`CHANGELOG.md` SHALL gain `## 0.6.0` above `## 0.5.1`, ≤ 25 lines, plain
prose, covering: two banks and the contract; the librarian; the fact line
format; `autoRecall` values and migration; "nothing to do if you never set
autoRecall — your behaviour is unchanged".

### Requirement: Version and tag

`package.json` version SHALL be `0.6.0`; tag `v0.6.0` is cut by the owner
after the live check — **this slice does not publish**.

## CONSTRAINTS

- Same repo/gate/worktree rules as slice 1. `make check` after every README
  edit.
- Do not weaken any test to make wording pass; change the wording instead.

## HOW TO PROVE IT

1. `make check` 0 FAIL, PASS ≥ base + all new checks from slices 1–5.
2. `npm pack --dry-run` lists `CHANGELOG.md` and `README.md`.
3. Reset `~/.pi/hindsight/changelog-state.json` to `{"lastNotifiedVersion":"0.5.1"}`,
   start pi: the 0.6.0 notes appear once at load.
4. `make shots` regenerates images without error; `git status` shows only
   intended image changes.

## REPORT SHAPE

Files; the CHANGELOG entry verbatim; the README headings added; PASS/FAIL;
the pack file list; confirmation of the live notice.
