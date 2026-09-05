# Slice 1 — Fact metadata in every recall line, and the bank name on every block

Parent plan: `PLAN.md` (approved). Beads: see the issue that links here.
Order: **first** of six. Nothing else depends on the wire format changing later,
so this lands before anything that prints facts.

## WHAT and WHY

Today every recalled fact reaches the agent as a bare `- ${text}`
(`src/recall.ts:123`, `:388`). The server returns far more per hit —
`mentioned_at`, `occurred_start/end`, `type`, `tags`, `entities`, `context`,
`document_id` (live `GET /openapi.json`, `components.schemas.RecallResult`) —
and we drop all of it. The owner's complaint: "facts arrive but we know neither
the date nor the tags, minimum info". The agent cannot tell a decision from an
observation, last week from last year, or the project bank from the user bank.

Separately, the epoch block built from the user bank (`src/user-block.ts`)
never names the bank it came from. The owner's rule: **every block the plugin
puts in front of the model says which bank it came from.**

This slice changes FORMAT only. No behaviour, no new calls, no new config.

## ALREADY DONE — do not re-verify

- `RecallResult` field list is confirmed against the live server, not docs.
- `RecallHit` (`src/recall-utils.ts:3-16`) already carries `text`, `id?`,
  `type?`; `extractHits` (`:288-312`) already reads `type`/`fact_type`.
- `HindsightClient.recall()` (`src/hindsight.ts`) already returns the raw
  response untouched; nothing strips metadata on the way in — the loss is
  purely in formatting.

## KNOWN FACTS (claims — read the code yourself; a discrepancy means trust your eyes)

- Format sites: `formatRecallHits` at `src/recall.ts:116-126` (tool path) and
  the `bullets` build at `src/recall.ts:388` (auto-recall path). Both must use
  ONE shared formatter or they will drift.
- `buildUserBlock` at `src/user-block.ts:268`; the block's first line is where
  the bank name goes. `USER_BLOCK_MAX_CHARS = 4000` (`:164`) still bounds the
  whole block INCLUDING the new header line.
- Tag convention on write: `[bankId, "agent-manual"|"agent-summary"|"user-manual", kind]`
  (`src/tools.ts:103`, `:148`; `src/memorize.ts:847`). The bank id is the
  first tag and is redundant in display; the source tag is meaningful.
- Tests asserting recall wording: `scripts/recall-block.test.ts`,
  `scripts/recall-judge.test.ts`, `scripts/turn-recall.test.ts`. README section
  `## The recall block` shows the three recall block forms and is checked by
  `recall-block.test.ts`.

## Specification

### Requirement: One fact line format, everywhere

The system SHALL render every recalled fact as
`- [<bank> · <date> · <type> · <tags>] <text>` optionally followed by
`(<entities>)`, from one exported function used by both the auto-recall path
and the `hindsight_recall` tool.

- `<bank>` — `project` or `user`, decided by the caller (which client answered),
  never inferred from tags.
- `<date>` — `occurred_start` if present, else `mentioned_at`, formatted
  `YYYY-MM-DD` (UTC date part of the ISO string). Missing → `—`.
- `<type>` — the hit's `type` verbatim. Missing → `—`.
- `<tags>` — the hit's `tags` minus the bank id (first tag) joined by `,`.
  Empty → `—`.
- `<entities>` — `entities` joined by `,`, appended in parentheses only when
  non-empty.
- `<text>` — as today (trimmed; dedup by `normalizeLine` unchanged).

#### Scenario: Full metadata

- **WHEN** a hit has `mentioned_at: "2026-08-15T10:22:00Z"`, `type: "world"`,
  `tags: ["pi-hindsight","agent-manual","decision"]`, `entities: ["Hindsight"]`
  and the caller marks it `project`
- **THEN** the line is exactly
  `- [project · 2026-08-15 · world · agent-manual,decision] <text> (Hindsight)`

#### Scenario: Bare hit

- **WHEN** a hit has only `text`
- **THEN** the line is `- [project · — · — · —] <text>` — positions never shift

#### Scenario: occurred_start wins over mentioned_at

- **WHEN** both are present and differ
- **THEN** the date shown is `occurred_start`'s date

### Requirement: The extractor keeps the metadata

`extractHits` SHALL populate `mentionedAt`, `occurredStart`, `tags`,
`entities`, `documentId` on `RecallHit` when the response carries them, and
SHALL leave them `undefined` (never `""`/`[]`) when it does not.

#### Scenario: Round trip

- **WHEN** a live-shaped `RecallResult` array is passed
- **THEN** each field above is present on the hit and equals the source value

### Requirement: The epoch block names its bank

`buildUserBlock` SHALL emit, as the FIRST line of the block,
`≡ user bank "<userBankId>"`. The bank id is passed in by the caller; the
function does not read config.

#### Scenario: Header present and bounded

- **WHEN** the block is built for bank `user`
- **THEN** line 1 is `≡ user bank "user"`, and the whole block including that
  line is ≤ `USER_BLOCK_MAX_CHARS`

#### Scenario: Byte-stable

- **WHEN** the same rows are passed twice
- **THEN** the two blocks are byte-identical (the header must not add a
  timestamp or anything that ticks)

### Requirement: Nothing else changes

Dedup, ordering, `maxLines`, the judge, the deep synthesis path, the fence
`--- end of recalled memory ---`, and the one-🧠-block-per-turn invariant are
untouched. The README's three recall-block examples are updated to the new
line format and `recall-block.test.ts` keeps passing.

## CONSTRAINTS

- Repo `/Users/dmitriynenashev/Projects/pi-hindsight`; gate `make check`;
  count passes with `make check 2>&1 | grep -c '^PASS'` (baseline 569 / 0 FAIL).
- Fresh worktree: `ln -sfn /Users/dmitriynenashev/Projects/pi-hindsight/node_modules node_modules`.
  `npm install` is forbidden.
- Never commit `.pi/hindsight.json`. Stage files by name. Comments explain WHY.
- Do not touch: `src/memorize.ts`, `src/mem-panel.ts`, the widget (`src/ui.ts`),
  task detector, invalidation, review queue.

## HOW TO PROVE IT

1. `scripts/recall-block.test.ts` gains the three scenarios above on fixture
   hits; `scripts/user-block-epoch.test.ts` asserts the header line and
   byte-stability.
2. Mutation: remove the date from the formatter → ≥1 FAIL; remove the header
   from `buildUserBlock` → ≥1 FAIL. Confirm each injection applied
   (`git diff --stat` shows the file), record the FAIL count, revert.
3. `make check`: 0 FAIL, PASS ≥ 569 + new checks.
4. Live: `pi -p "что мы решили про кэш промпта?"` in this repo with
   `debug: true` — the 🧠 block in `.pi/hindsight/debug.log` (`injectedText`)
   shows `[project · 2026-…` on every line.

## REPORT SHAPE

Files changed; the exported formatter's name and signature; the three fixture
lines verbatim as produced; PASS/FAIL before and after; per mutation: what was
broken, proof it applied, FAIL count; one live `injectedText` excerpt.
