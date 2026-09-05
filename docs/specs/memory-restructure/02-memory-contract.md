# Slice 2 — The two-memory contract in the system prompt

Parent plan: `PLAN.md` (approved). Order: **second**; depends on slice 1 only
for the wording of "you will see facts tagged project/user".

## WHAT and WHY

The agent has two banks to write to (`hindsight_retain` → project bank
`bankId`; `hindsight_retain_user` → user bank `userBankId`) but nothing in its
instructions tells it **which is which and when to use each**. Today that
knowledge lives only in the tool descriptions (`src/tools.ts:126-135`), which
the model reads once and forgets. The owner wants a standing instruction in
the system prompt: what the PROJECT bank is for (decisions about THIS project
— a repository, a folder, anything with `.pi/hindsight.json`), what the USER
bank is for (how this PERSON wants to be worked with, true in any project),
the one-sentence test, and "ask memory yourself before a non-trivial task".

The hard constraint is the prompt cache: anything that changes between turns
inside the system prompt costs 12–14× on every turn (bank fact, measured on
session `usage`). So the instruction is inserted **once per epoch** and is
byte-identical across turns, exactly like the user block.

## ALREADY DONE — do not re-verify

- Epoch mechanics exist: `openUserEpoch(cwd, reason, ui)` at
  `src/index.ts:393` runs on `session_start` (`:623`) and `session_compact`
  (`:687-694`); the `before_agent_start` handler at `:699-737` returns ONLY a
  `systemPrompt`, never a message, and is pure string work.
- `userBankOf(cfg)` (`src/index.ts:163-166`) is the single truth for "is there
  a user bank"; `registerTools(pi, getState, userBankOf(cfg))` (`:206`) already
  registers `hindsight_retain_user` only when it returns a bank.
- `applyUserBlock` / `hasMarker` (`src/user-block.ts`) own the marker
  `<!-- hindsight:user -->`.

## KNOWN FACTS (claims — verify)

- The prompt text to insert is fixed in `PLAN.md` § Подход 1 under
  `## Memory`. Use it verbatim; only `<bankId>` and `<userBankId>` are
  substituted.
- pi concatenates every extension's `systemPrompt` return in registration
  order (bank fact); our handler must append, not replace.
- `scripts/user-block-epoch.test.ts` + `scripts/user-block-harness.ts` drive
  a full session (start → turns → compact) and can read the system prompt per
  turn.

## Specification

### Requirement: The contract is appended once per epoch

The system SHALL append the `## Memory` instruction to the system prompt on
the first turn of every epoch and SHALL return the byte-identical prompt on
every later turn of that epoch.

#### Scenario: Stable across turns

- **WHEN** a session starts and runs 10 turns without compaction
- **THEN** the system prompt on turns 1..10 is byte-identical, and contains
  exactly one `## Memory` heading

#### Scenario: Re-decided at a boundary

- **WHEN** compaction succeeds (`session_compact`) and `bankId` was changed in
  config between the epochs
- **THEN** the next turn's contract names the new `bankId`

### Requirement: The user half follows the user bank

The `USER bank "…"` paragraph and the `hindsight_retain_user` sentence SHALL
appear if and only if `userBankOf(cfg)` returns a bank.

#### Scenario: No user bank

- **WHEN** `userBankId` is empty
- **THEN** the contract has the PROJECT paragraph and the recall sentence, no
  `USER bank` text, and `hindsight_retain_user` is not registered

### Requirement: Inactive project, no contract

- **WHEN** `cfg.active` is false (no bank declared here)
- **THEN** nothing is appended — the marker block rule (`epochInjects`) is
  unchanged

### Requirement: Tool descriptions and the contract agree

`hindsight_retain`, `hindsight_retain_user` and `hindsight_recall`
descriptions SHALL be shortened to one sentence each that defers to the
contract ("see the Memory section of your instructions"), so there is one
source of the rule, not two that drift.

## CONSTRAINTS

- Same repo/gate/worktree rules as slice 1.
- Do not touch `applyUserBlock`'s marker handling, `reminderTail`, the
  widget, or any auto-recall behaviour (slice 4 owns that).
- The contract lives in `src/prompts.ts` as an exported builder
  `memoryContract(bankId, userBankId?)`.

## HOW TO PROVE IT

1. `scripts/user-block-epoch.test.ts`: the three scenarios above.
2. Mutation: make the handler rebuild the text with `Date.now()` in it → the
   "stable across turns" check FAILs. Make the user paragraph unconditional →
   the "no user bank" check FAILs. Record counts, revert.
3. `make check` 0 FAIL.
4. Live: start pi in this repo with `debug: true`, ask any question, read
   `.pi/hindsight/debug.log` — the `event.before_agent_start` entry's prompt
   length is identical on turns 2 and 3.

## REPORT SHAPE

Files changed; the exact inserted text for this repo (both banks); the prompt
byte length on turns 1, 2, 10 from the test; PASS/FAIL before/after; per
mutation: what, proof, count.
