# Slice 4 — `autoRecall` becomes three-valued; auto-recall only at epoch boundaries

Parent plan: `PLAN.md` (approved) § Подход 5. Order: **fourth**; depends on
slice 2 (the contract tells the agent to call `hindsight_recall` itself) and
slice 3 (the tool must be worth calling before auto-recall retreats).

**Owner decision pending (Blocking question 1 in the plan): the new default.**
Build with `"boundaries"` as default; if the slice-3 cost measurement's median
exceeds **$0.02 per delegation**, ship with `"every-turn"` as default instead
and say so in the report. The decision is taken on the number, not in advance.

## WHAT and WHY

Today a recall runs before **every** turn (`src/index.ts:754`, guarded by
`runtime.autoRecall`). With the contract (slice 2) telling the agent to ask
memory itself and a librarian (slice 3) worth asking, a per-turn auto-recall
becomes a second 🧠 block and a second bill. The cheapest, most useful moments
for an automatic recall are the epoch boundaries — session start and after a
successful compaction — where the agent has no context yet.

## ALREADY DONE — do not re-verify

- `autoRecall: boolean` at `src/config.ts:84`, default via
  `envBool("HINDSIGHT_AUTO_RECALL", true)` (`:318`), forced `false` for an
  inactive project (`:355`).
- Runtime mirror `runtime.autoRecall` (`src/index.ts:496`, `:547`); widget
  `status.recallOn()/recallOff()` (`:549`); the turn gate at `:754`.
- `/mem-auto` (`src/commands.ts:280-316`) flips the runtime boolean; the
  Settings tab cycles `on/off` (`src/mem-panel.ts:353-358`, `:643`).
- Epoch boundaries: `session_start` (`src/index.ts:570`) and
  `session_compact` (`:687`).

## KNOWN FACTS (claims — verify)

- `scripts/turn-recall.test.ts` and `scripts/user-block-harness.ts` can drive
  N turns and a compaction and observe whether a 🧠 block was injected.
- `scripts/config-merge.test.ts` covers env → global → project merging and is
  where the migration belongs.

## Specification

### Requirement: Three values, with migration

`autoRecall` SHALL be `"boundaries" | "every-turn" | "off"`. Loading SHALL
map a legacy boolean: `true → "every-turn"`, `false → "off"`, from env, global
and project files alike. `envBool` is replaced by an enum parser that accepts
the three strings and the two legacy booleans, and falls back to the default
on anything else.

#### Scenario: Legacy true keeps today's behaviour

- **WHEN** the project file says `"autoRecall": true`
- **THEN** the resolved value is `"every-turn"` and a block is injected on
  every turn

#### Scenario: Legacy false

- **WHEN** the global file says `false`
- **THEN** resolved `"off"`, no automatic block on any turn or boundary

### Requirement: `"boundaries"` injects at start and after compaction only

- **WHEN** `"boundaries"` and the session runs: start, turns 1–5, compaction,
  turns 6–8
- **THEN** a 🧠 block is present on turn 1 and turn 6 and on **no other** turn

### Requirement: The reminder still works

The bank reminder (`reminderTail`, `bankReminderTurns`) SHALL keep firing in
`"boundaries"` mode exactly as it does today in `every-turn` mode when no
block was injected — it is the only tail allowed on an ordinary turn.

### Requirement: Surfaces follow the enum

- Settings tab row "Auto recall" SHALL cycle `boundaries / every-turn / off`.
- `/mem-auto` SHALL accept `recall boundaries|every-turn|off` and print the
  current value; bare `recall` toggles between `off` and the configured
  non-off value.
- The widget's recall fragment SHALL show `↙` states as today for
  `every-turn`, the same for `boundaries`, and the off glyph for `off`.
- Status tab "Recall" row SHALL print `auto boundaries · effort normal`.

### Requirement: Task detector unchanged

The task detector and deep-recall-on-task-change path are not modified; in
`"boundaries"` mode they simply never run because no per-turn recall runs.

## CONSTRAINTS

- Files: `src/config.ts`, `src/index.ts`, `src/commands.ts`,
  `src/mem-panel.ts` (row values + Status label only), `src/ui.ts` (only if
  the off glyph needs the enum — prefer none).
- Do not change `runRecall` internals, the judge, `reminderTail`.
- Same repo/gate/worktree rules as slice 1.

## HOW TO PROVE IT

1. `scripts/config-merge.test.ts`: both legacy mappings, the three strings,
   and garbage → default. `scripts/turn-recall.test.ts`: the boundaries
   scenario (turn 1 yes, 2–5 no, 6 yes, 7–8 no) and the every-turn scenario
   (all yes). `scripts/mem-panel.test.ts`: the row cycles three values.
2. Mutation: make the turn gate ignore the mode → the "turn 2 has no block"
   check FAILs. Drop the legacy mapping → the `true → every-turn` check
   FAILs. Record, revert.
3. `make check` 0 FAIL.
4. Live: with `"boundaries"` in `.pi/hindsight.json` (temporarily; do not
   commit), start pi, send three messages, read `.pi/hindsight/debug.log` —
   `event.before_agent_start` shows an injection on turn 1 only.

## REPORT SHAPE

Files; the parser's accepted inputs table; the default shipped and the cost
number that decided it; PASS/FAIL before/after; per mutation: what, proof,
count; the live log excerpt for turns 1–3.
