# Slice 3 — The librarian: `hindsight_recall` becomes a nested tool-using agent

Parent plan: `PLAN.md` (approved) § Подход 3. Order: **third**; needs slice 1's
formatter. The riskiest slice: cost and `convertToLlm` behaviour are unknown
until the first live run — **measure, do not assume**.

## WHAT and WHY

Today `hindsight_recall` is one `POST /recall` (`src/tools.ts:167-200`). The
owner wants it to be a **delegation**: the main agent asks, a small fast model
("the librarian") searches the banks with its own tools — as many calls as it
needs, within a limit — and returns a BUILT answer with sources. The server's
`POST /reflect` exists but is weaker: one pass, no follow-up. The librarian may
use it as a first draft and then top up with `recall`.

Architecture (from the plan, do not re-derive): **`runAgentLoop` from
`pi-agent-core`** — the same loop pi itself runs on — with four internal tools
the main agent never sees. No spawned process, no second turn, no message into
the main context: the result is a tool result and nothing else.

## ALREADY DONE — do not re-verify

- `runAgentLoop(prompts, context, config, emit, signal, streamFn)` is exported
  from `pi-agent-core/dist/agent-loop.d.ts:22`; `AgentContext =
  { systemPrompt, messages, tools? }` (`types.d.ts:359`);
  `AgentLoopConfig extends SimpleStreamOptions { model, convertToLlm, … }`.
- `streamSimple(model, context, options)` from `pi-ai` is a valid `StreamFn`
  (`pi-ai/dist/compat.d.ts:65`).
- Model auth: `ctx.modelRegistry.getApiKeyAndHeaders(model)` (used in
  `src/model.ts:178`); chain resolution `resolveChain(ctx, cfg, "recall")`
  (`src/model.ts:103`) yields `candidates[]` with fallback order.
- `HindsightClient.recall(query, opts, signal)` (`src/hindsight.ts`) sends
  `tags`, `types`, `budget`, `max_tokens`; `reflect(query, signal)` exists with
  a 180 s timeout. `RecallRequest` also accepts `tags_match`, `temporal_window`,
  `query_timestamp` (live openapi) — the client must be extended.
- A tool's `execute(toolCallId, params, signal, onUpdate, ctx)` blocks the
  main agent until it returns (`dist/core/extensions/types.d.ts:372`).

## KNOWN FACTS (claims — verify)

- `userBankOf(cfg)` (`src/index.ts:163`) builds a second `HindsightClient`
  bound to `userBankId`; `registerTools` already receives it.
- `recallTimeout` exists in config (default 8000 ms, bank fact) — raise to
  20000 for the librarian only; do not change the auto-recall timeout.
- Debug log: `appendDebug(cwd, stage, payload)` (`src/log.ts`).

## Specification

### Requirement: Four internal tools, invisible to the main agent

The librarian SHALL have exactly these tools, registered in its own
`AgentContext.tools`, never via `pi.registerTool`:

| tool | does | limit |
|---|---|---|
| `bank_reflect(bank, question)` | `POST /reflect` on that bank; returns the draft text | ≤ 1 call per bank per run |
| `bank_search(bank, query, tags?, since?)` | `POST /recall` with `include`, `tags`/`tags_match:"any"`, `temporal_window` from `since` | ≤ 12 facts per call |
| `bank_document(bank, document_id)` | `GET` the source document | ≤ 4000 chars, truncated with `…` |
| `answer(summary, facts[])` | ends the loop | exactly once |

`bank` is `"project"` or `"user"`; `"user"` is refused with a tool error when
no user bank exists.

#### Scenario: Reflect then search then answer

- **WHEN** the stubbed model calls `bank_reflect(project)`, then
  `bank_search(project, "кэш промпта")`, then `answer(...)`
- **THEN** the result carries the summary, the facts formatted by slice 1's
  formatter with `bank=project`, and `steps.length === 3`

#### Scenario: Second reflect on the same bank is refused

- **WHEN** the model calls `bank_reflect(project)` twice
- **THEN** the second call returns a tool error naming the limit and does not
  hit the server

### Requirement: Limits and the honest fallback

The loop SHALL stop after `recallMaxToolCalls` (config, default **4**, `answer`
not counted) tool calls or `recallTimeout` (20000 ms) and SHALL then return
the raw hits of the LAST `bank_search` prefixed by `(no summary: step limit)`
— facts beat a missing summary.

#### Scenario: Step limit

- **WHEN** the stubbed model issues 5 `bank_search` calls and never `answer`s
- **THEN** the 5th is not executed, the result starts with
  `(no summary: step limit)`, and the facts are those of call 4

#### Scenario: Abort

- **WHEN** `signal.abort()` fires mid-loop
- **THEN** the tool rejects with an abort error within 100 ms and no further
  server call is made

### Requirement: Model fallback

- **WHEN** the first candidate of the recall chain throws a non-abort error
- **THEN** the loop is retried from scratch on the next candidate; the final
  error names every candidate tried (`all models failed: luna → terra`)

### Requirement: `scope`

`hindsight_recall(question, scope = "both")` SHALL expose
`scope: "project" | "user" | "both"`; the librarian's prompt names the banks
it may use accordingly, and `bank_*` tools refuse a bank outside the scope.

### Requirement: The librarian's prompt

Short, in `src/prompts.ts` as `LIBRARIAN`: reflect first if the question is
broad; top up with `bank_search` on concrete words; read `bank_document` only
when a fact is cut off; `answer` with a brief coherent summary plus the facts
relied on; never invent — if the bank is silent, say so.

### Requirement: Steps are recorded, not shown

Every tool call SHALL append `{ tool, bank, arg, outcome, ms }` to a `steps[]`
array returned alongside the result, and SHALL be written to
`.pi/hindsight/debug.log` as stage `recall.agent.step` when `debug` is on.
Nothing about steps goes into the tool's `content` (slice 5 owns display).

## CONSTRAINTS

- New file `src/recall-agent.ts`; `src/tools.ts` only wires it in.
- `convertToLlm`: start with identity; if the first live run rejects
  `toolResult` messages, fix it THERE and report what was needed.
- Do not touch auto-recall (`src/recall.ts` `runRecall`), the judge, task
  detector, widget, panel.
- Same repo/gate/worktree rules as slice 1.

## HOW TO PROVE IT

1. New `scripts/recall-agent.test.ts` with a stub `streamFn` that replays a
   scripted list of tool calls: scenarios (a) reflect→search→answer,
   (b) step limit, (c) fallback to the second model, (d) abort, (e) second
   reflect refused, (f) `scope:"project"` refuses `bank_search(user, …)`.
   Wire it into `Makefile` `check`.
2. Mutation: remove the step-limit check → (b) FAILs; swap the fallback loop
   for a single attempt → (c) FAILs. Record, revert.
3. `make check` 0 FAIL.
4. **Live**: in this repo with `debug: true`, run
   `pi -p "что мы решили про кэш промпта?"` — `.pi/hindsight/debug.log`
   shows ≥1 `recall.agent.step` and one `answer`.
5. **Measure**: 10 real questions from `docs/memory-quality-audit.md` (pick
   the first 10 bullets); sum `usage` from every model response; report
   min/median/max cost per delegation in $ using the luna prices in the bank
   (in 0.20, cache-read 0.02, cache-write 0.25, out 1.20 per 1M).

## REPORT SHAPE

Files; the librarian prompt verbatim; what `convertToLlm` needed; PASS/FAIL
before/after; per mutation: what, proof, count; the 10-question cost table
(question, steps, tokens in/out, $); the median in one line.
