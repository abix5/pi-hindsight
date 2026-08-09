# pi-hindsight

Long-term project memory for the [pi coding-agent](https://github.com/earendil-works/pi),
backed by a local [Hindsight](https://github.com/threadway/hindsight) instance.

> **Need Hindsight running first?** On macOS the fastest way to spin up a local
> instance is [**hindsight-setup**](https://github.com/abix5/hindsight-setup) —
> simple and quick.

pi-hindsight gives the agent a durable memory of your project that survives across
sessions and context compaction. It works in two directions:

- **Recall** — before each turn it searches the memory bank and injects the few
  most relevant facts into the agent's context, so past decisions, pitfalls and
  project facts are not forgotten or re-derived.
- **Memorize** — when the conversation is compacted (or on demand), it extracts
  the durable *system knowledge* from the slice that is about to be discarded,
  de-duplicates it against what the bank already knows, and stores only what is
  new — all in the background, without blocking the agent.

A small status widget shows both contours live, on one line:

```
🧠 ● pi-hindsight ↙↗ 16d 153f · ↙ recall · 12→3 · db migration command
```

Bank dot · bank id · auto-mode · bank size (`16d` documents, `153f` facts) ·
the last memory action. Auto-mode markers: `↙` = recall, `↗` = retain,
`auto off` = both disabled. On a recall, `12→3` is *found → injected* (the rest
were already seen this session).

---

## How it works

### Recall (read path — inline)

Runs on the `before_agent_start` hook and works in three stages, all on a cheap
model.

**1. Build the fewest queries that cover the request.** The message plus the
recent conversation (user/assistant prose, agent thinking, and tool *calls* —
never tool output) is turned into **1–5 standalone bank queries**. Fewer is
better: one well-aimed query is the preferred answer, and a second is added only
when the request spans genuinely separate subjects. Queries are search keys made
of concrete subjects (paths, identifiers, config keys), never a reworded copy of
the message. A message that yields no searchable subject even in context (a bare
"continue" / "ok") skips the lookup entirely.

**2. One independent recall per query, in parallel.** Every query gets its own
bank call *and* its own verdict: the model scores that query's hits 0–100 and
keeps only the facts that genuinely answer it. Judging per query — rather than
once over a merged pool — is what stops a vague query's noise from crowding out
a precise query's facts, and lets a query that returned only junk be dropped
whole (score below 25).

**3. Merge into the final block.** Surviving facts are merged best-scoring query
first, de-duped against facts already injected this session, and capped at
`recallMaxLines`, so an exhausted line budget costs the *weakest* query its tail.
The result is an *untrusted reference* block for the current turn. Nothing is
rewritten or invented — facts are injected verbatim and the main model weaves
them in. When the bank answers but every fact is judged irrelevant, **nothing**
is injected.

Two operations are supported:

- `recall` (default) — return the raw relevant facts.
- `reflect` — ask Hindsight to compose a direct answer from the bank, used only
  for self-contained factual questions.

If every model in the chain is down, recall degrades to keyword queries and
injects unjudged hits rather than losing memory entirely.

### Memorize (write path)

Triggered on context compaction, the manual `/mem-save` command, and — as a
last-chance safety net — when a session is **quit or replaced by `/new`** (so an
un-memorized tail is not lost). It is **never** triggered by `/reload` (nothing
is lost there). Compaction and manual writes are fire-and-forget (the agent
never waits); the session-close write is awaited before the process exits,
bounded by a 60s cap so quitting can never hang.

The whole pipeline — distil → merge → verify → **bank-aware dedup** → store —
runs *inside the extension* via isolated model completions and a direct bank
write. It is **invisible to the conversation**: no agent turn is triggered,
nothing is injected into the chat, and the main model never reacts to it. All
the small-model steps go through a completion API (`complete()`), not a
conversation turn, so the write never pollutes context.

The **bank-aware dedup** step is what keeps facts from piling up. Before storing,
it asks the small model to cluster the note by meaning into a few standalone
queries, recalls the bank from those angles, and drops any bullet whose meaning
is already stored **anywhere** in the bank. This is the cross-document
deduplication that `document_id` *cannot* provide — the id only stops the same
transcript window from duplicating on re-ingest, not the same fact recurring
across different windows or sessions. A single whole-note query misses
already-stored facts on the note's other topics; grouping into a handful of
topical queries surfaces far more of them at a bounded number of requests.

Every write carries a **deterministic `document_id`** derived from the session
and the exact transcript window (`pi-` + sha256 of session + first/last entry
id). Re-ingesting the same window — a retried write, a repeated flush — *upserts*
the existing document in the bank instead of piling up duplicates. Each
stored window is also recorded in an append-only journal
(`.pi/hindsight/dispatch-log.jsonl`), which is what lets `/mem-save all` first
**delete** this session's previously stored documents from the bank and then
re-collect the whole session cleanly — no duplicate facts, however the windows
were cut before.

On startup the extension also syncs two **extraction levers onto the bank
itself** (`retain_mission` and `observations_mission` via the bank config API):
plain-language missions that steer Hindsight's own fact extraction and
observation consolidation toward durable engineering knowledge (decisions +
rationale, constraints, verified know-how, pitfalls, concrete locations) and
away from session narration and one-off task chatter. The sync is a no-op when
the bank already matches.

### Review (`/mem` → Review tab)

Documents are stored to the bank **immediately** (so dedup and recall always
work against fresh knowledge), and every stored document is also placed in a
**global review queue** (`~/.pi/hindsight/review-queue.jsonl`, shared across
all projects). `/mem` opens a TUI panel right in the terminal; the **Review**
tab walks the pending documents (newest first) showing each one's full text,
fact count, project and trigger — so you can:

- **Approve** (`a`) — you are done with it; removes it from the queue (the bank
  is untouched).
- **Edit** (`e`) — fix the text in place; the document is re-stored under the
  *same* `document_id`, so the bank replaces the old facts with the corrected
  ones.
- **Delete** (`d`) — remove the document and its facts from the bank entirely.

Queue entries whose document never made it to the bank (a run that produced
nothing durable) are dropped automatically. The queue is an append-only event
log, so parallel pi sessions can write to it safely.

### Pointers & `/mem-retain`

Two markers track memory, answering different questions:

- **Watermark** — *how far through the transcript* has been memorized. It only
  moves forward; the next write resumes right after it. `/mem-mark` advances it
  to now **without writing** (mark everything so far as already processed).
- **Saved ranges** — *which blocks were already stored out-of-band* by
  `/mem-retain`. `/mem-retain <prompt>` hands the agent a study task; the
  agent gathers what it needs and stores the durable facts immediately (so it
  works even with auto-retain off). The transcript range of that work is
  recorded, and at the next memorize it is wrapped in `ALREADY SAVED` markers so
  the extractor sees it for context but does **not** extract those facts a
  second time — no duplicates, no bank lookup, and the agent can keep using the
  facts in the conversation. The range is dropped once the watermark passes it.

---

## Requirements

- **pi coding-agent** (provides the extension runtime, model registry, and host
  packages used by the extension APIs).
- A running **Hindsight** HTTP API — by default `http://localhost:8888`,
  namespace `default`. On macOS, the easiest way to get one is
  [**hindsight-setup**](https://github.com/abix5/hindsight-setup).
  **v0.8.4+** recommended: recall uses `prefer_observations` (provenance-based
  dedup of raw facts superseded by observations). Older servers just ignore the
  flag — no error, but no server-side dedup either.
- **bun** — the extension runs as TypeScript.
- **A small model** in your pi model registry for the recall/write pipeline
  (`recallModelId` / `retainModelId`). A single cheap model is enough. See
  *Configuration*.

No taskflow, `jq`, or `curl` is needed — the write path runs entirely in-process.

---

## Install

The package declares `pi.extensions`, so the simplest install is:

```bash
pi install npm:@abix5/pi-hindsight
```

That registers the extension for pi automatically — then jump to step 3
(models) and step 4 (declare a bank).

Prefer to wire it by hand (or develop locally)? Do it manually:

1. **Install the package**:

   ```bash
   npm install -D @abix5/pi-hindsight
   ```

   Or clone it somewhere stable if you prefer local development:

   ```bash
   git clone https://github.com/abix5/pi-hindsight.git ~/tools/pi-hindsight
   ```

2. **Add a loader** in your project at `.pi/extensions/hindsight.ts`:

   ```ts
   export { default } from "@abix5/pi-hindsight";
   ```

   For a local clone, point at the source path instead:

   ```ts
   export { default } from "/absolute/path/to/pi-hindsight/src/index.ts";
   ```

   (Running pi *inside this repo* works out of the box — a loader is already
   present.)

3. **Set your models** globally in `~/.pi/agent/hindsight.json` (see
   *Configuration*): `recallModelId` and `retainModelId`. A single cheap model
   for both is fine.

4. **Declare a bank** in the project's `.pi/hindsight.json` to activate the
   plugin here (see below), trust the project, then `/reload` in pi. Without a
   project bank the plugin stays **dormant** — no recall, no widget — so the
   loader is safe to keep globally and only wakes up in projects you opt in.

5. Open the panel with `/mem` → the **Status** tab confirms the bank
   connection; the **Settings** tab is where you configure everything visually.

---

## Configuration

Config is merged from three layers, later wins:
**env defaults → global `~/.pi/agent/hindsight.json` → project `.pi/hindsight.json`**.

Put shared settings (baseUrl, namespace, models, language, missions, effort,
categories, auto-flags) in the **global** file once, and keep only the
per-project **bank** (and any project-specific overrides) in the project file.
The easiest way to edit both is the `/mem` panel's **Settings** tab, which
writes the bank id to the project file and every other preference to the global
one.

### Activation is gated on a bank

The plugin only runs in a project that declares a bank:

- `"bankId": "my-project"` in the **project** file → active, uses that bank.
- `"bankId": "auto"` (project **or** global) → active, bank = project folder
  slug. Set it globally to opt every project in with a folder-derived bank.
- No bank declared anywhere → **dormant** (a concrete `bankId` set only in the
  *global* file is ignored on purpose, so all projects never collapse into one
  shared bank).

A typical **global** `~/.pi/agent/hindsight.json`:

```json
{
  "baseUrl": "http://localhost:8888",
  "namespace": "default",
  "recallModelId": "your-provider/small-model",
  "retainModelId": "your-provider/small-model",
  "memoryLanguage": "en",
  "autoRecall": true,
  "autoMemorize": true,
  "recallOperation": "recall",
  "recallFilter": "model",
  "recallEffort": "normal",
  "recallMaxQueries": 8,
  "recallMaxLines": 8,
  "recallContextTokens": 5000,
  "factCategories": {
    "goal": "on",
    "decisions": "on",
    "constraints": "on",
    "knowhow": "on",
    "pitfalls": "on",
    "facts": "on",
    "code": "off",
    "domain": "off"
  }
}
```

Then each project you want memory in just declares its bank:

```json
{ "bankId": "my-project" }
```

| Key | Env | Default | Meaning |
| --- | --- | --- | --- |
| `bankId` | `HINDSIGHT_BANK` | — (dormant) | Memory bank id; set it (or `"auto"`) to activate the plugin in a project |
| `baseUrl` | `HINDSIGHT_BASE_URL` | `http://localhost:8888` | Hindsight API base URL |
| `namespace` | `HINDSIGHT_NAMESPACE` | `default` | API namespace (path after `/v1`) |
| `autoRecall` | `HINDSIGHT_AUTO_RECALL` | `true` | Search memory before each turn (toggle in the `/mem` Settings tab) |
| `autoMemorize` | `HINDSIGHT_AUTO_MEMORIZE` | `true` | Write memory on compaction and session close (toggle in the `/mem` Settings tab) |
| — | `HINDSIGHT_AUTO_OFF` | `false` | **Kill switch for spawned processes.** Forces both contours off, overriding every config layer (see below) |
| `recallModelId` | `HINDSIGHT_RECALL_MODEL` | `openai/gpt-5.6-luna` | Model for recall query-building / per-query judging |
| `retainModelId` | `HINDSIGHT_RETAIN_MODEL` | `openai/gpt-5.6-luna` | Model for the write pipeline (extract / merge / verify / dedup) |
| `recallModelChain` | `HINDSIGHT_RECALL_MODEL_CHAIN` | `[]` | Ordered fallbacks tried when the recall model fails (the session model is always the last resort) |
| `retainModelChain` | `HINDSIGHT_RETAIN_MODEL_CHAIN` | `[]` | Ordered fallbacks tried when the retain model fails (the session model is always the last resort) |
| `recallOperation` | `HINDSIGHT_RECALL_OPERATION` | `recall` | `recall` (facts) or `reflect` (answer) |
| `recallEffort` | `HINDSIGHT_RECALL_EFFORT` | `normal` | Query ceiling per recall: `light` (2) / `normal` (3) / `thorough` (5) (set in the `/mem` Settings tab) |
| `recallMaxQueries` | `HINDSIGHT_RECALL_MAX_QUERIES` | `8` | Hard ceiling on total bank queries per recall |
| `factCategories` | — | all on except code/domain | Tri-state map of which categories to extract (set in the `/mem` Settings tab) |
| `recallFilter` | `HINDSIGHT_RECALL_FILTER` | `model` | `model` (per-query LLM judge scores hits and drops junk) or `off` |
| `recallMaxLines` | `HINDSIGHT_RECALL_MAX_LINES` | `8` | Max facts injected per turn |
| `recallContextTokens` | `HINDSIGHT_RECALL_CONTEXT_TOKENS` | `5000` | Recent-context budget for query building (tool output excluded) |
| `taskDetect` | `HINDSIGHT_TASK_DETECT` | `true` | Run the task-change detector and the deep pass it triggers (see below) |
| `taskHistoryTurns` | `HINDSIGHT_TASK_HISTORY_TURNS` | `12` | Safety cap on detector history turns (normally truncated at task boundaries) |
| `taskTitleTail` | `HINDSIGHT_TASK_TITLE_TAIL` | `8` | Past task titles kept in the detector prompt so a RETURN is not read as a new task |
| `deepRecallQueries` | `HINDSIGHT_DEEP_RECALL_QUERIES` | `5` | Bank queries the deep pass may run |
| `deepRecallMaxLines` | `HINDSIGHT_DEEP_RECALL_MAX_LINES` | `24` | Judged facts fed to the deep pass synthesis |
| `bankReminder` | `HINDSIGHT_BANK_REMINDER` | `true` | Inject the short "the bank exists, ask it" nudge (see below) |
| `bankReminderTurns` | `HINDSIGHT_BANK_REMINDER_TURNS` | `10` | Turns between nudges (the first one rides on the first turn of a session) |
| `memoryLanguage` | `HINDSIGHT_MEMORY_LANGUAGE` | `en` | Language all stored memory is written in (code identifiers stay verbatim) |
| `retainMission` | `HINDSIGHT_RETAIN_MISSION` | engineering-focused | Bank-side extraction mission, synced to the bank at startup |
| `observationsMission` | `HINDSIGHT_OBSERVATIONS_MISSION` | engineering-focused | Bank-side observation-consolidation mission, synced at startup |
| `dispatchLogPath` | `HINDSIGHT_DISPATCH_LOG_PATH` | `.pi/hindsight/dispatch-log.jsonl` | Journal of stored documents (powers `/mem-save all` cleanup) |
| `countsRefreshMs` | `HINDSIGHT_COUNTS_REFRESH_MS` | `20000` | Widget counter refresh interval |
| `debug` | `HINDSIGHT_DEBUG` | `false` | Verbose logging (full prompts/bodies) — **may leak sensitive data** |

> The write pipeline runs entirely off-conversation via `retainModelId` — no
> agent turn, no context pollution — and includes the bank-aware cross-document
> dedup step. `recallModelId` / `retainModelId` can be the same model.

### Task boundaries: one briefing instead of scattered facts

Injecting a handful of loose facts on *every* turn measurably hurts: Hindsight's
own benchmark of exactly that shape recorded 1.06 corrections per task against
0.97 with no memory at all — scattered fragments break focus.

So ordinary turns keep the cheap contour (query builder → bank → per-query judge
→ up to `recallMaxLines` facts), and the expensive pass runs only at a **task
boundary**. A separate cheap model keeps its own short conversation next to the
main one — a digest of each answer (first sentence + files written) plus your
message verbatim — and answers, per turn, whether the work has moved to a
different subject. On a change the history is dropped, so what remains always
describes the task in progress; the finished task's title joins a short tail so
returning to a morning topic is recognised as a *return*.

The deep pass fires on exactly three triggers: the detector said the task
changed, the first turn of a session, and the first turn after a compaction. It
runs a wider recall driven by the detector's query, judges each query's hits as
usual, and then makes **one** cheap-model call that writes a coherent briefing —
which is injected instead of the bullet list.

`POST /reflect` is deliberately **not** used here: measured across four banks it
takes 28–59s and the curve is flat in bank size (a 10-fact bank still answers in
28s), because it is an LLM-bound agent loop. The `hindsight_reflect` tool stays
available for the agent to call deliberately.

The detector never lengthens an ordinary turn: it runs concurrently with the
ordinary recall, and its verdict only decides which result is used. Set
`taskDetect` to `false` to go back to plain per-turn recall.

### The bank reminder

The automatic contour catches topic changes on its own, but the model is the
only party that reads the whole conversation — it knows when *it* is short of
context. It just forgets the `hindsight_*` tools exist after a dozen turns, and
a forgotten tool is a dead tool.

So on the first turn of a session, and every `bankReminderTurns` turns after
that, one short block is injected: the bank's name and size, and a pointer to
`hindsight_recall` / `hindsight_reflect` / `hindsight_retain`. It is labelled as
plugin output so it reads neither as a user instruction nor as recalled facts,
and it costs nothing — no model call, no bank call, just the counters the widget
already polls.

The counter is a blind modulo, deliberately **not** reset at a task boundary:
forgetting tracks turns since the tools were last mentioned, not task identity,
and a boundary already injects a visible briefing that reminds the model by
itself. Nothing is injected when the project has no declared bank or auto-recall
is off — a reminder about a bank that is not there is pure noise. Tune the
interval with `bankReminderTurns`, or set `bankReminder` to `false`.

### Turning the automatic contours off

The tools (`hindsight_recall` / `hindsight_reflect` / `hindsight_retain`) and the
background contours are independent: you can keep memory reachable **on demand**
while nothing happens automatically.

**`--mem-only-tools` — tools and nothing else.** The intended mode for workflow
subtasks and scripted runs:

```bash
pi --mem-only-tools -p "..."
```

The extension registers the three bank tools and **stops**: no widget, no
commands, no session hooks, no background timers, no pre-turn recall, no write
on compaction or exit. Config layers are still read, so a declared bank is used
when there is one. Fully ephemeral subagents (`pi --no-session`) already behave
this way without the flag.

**Softer switches**, when you want the plugin loaded but quiet:

- `/mem-auto off` — both contours off for this session (`/mem-auto recall` or
  `retain` toggles just one). Session-scoped; nothing is written to disk.
- `HINDSIGHT_AUTO_OFF=1` — same thing for a spawned process, but the widget,
  commands and hooks still load.

  Ordinary config keys follow `env → global file → project file`, so a project
  that opted into `"autoRecall": true` would otherwise re-enable it inside the
  child process. This flag is applied **last, on top of every layer**, so a
  parent can always guarantee silence in the processes it spawns.

### Model fallback

Every memory model call walks a chain rather than trusting one provider:
`<role>ModelId` → each id in `<role>ModelChain` → **the session's own model**.
A candidate that errors (auth failure, timeout, 5xx) is logged and the next one
answers; only Esc/abort stops the walk. If *every* model is unreachable, recall
still queries the bank — it degrades to keyword queries distilled from your
message instead of skipping memory for that turn (the trace says `degraded`).

---

## Commands & shortcuts

Six commands, plus one TUI hub for everything else:

| Command | What it does |
| --- | --- |
| `/mem` | Open the **panel** in the terminal: Status · Settings · Review · Log. This is the single place for configuration, document review, history, and health. Works even when the project is dormant (set a bank in Settings to activate). |
| `/mem-save [all]` | Save the accumulated context now. `/mem-save all` re-collects the **whole** session (deletes this session's previously stored documents first, then re-ingests). |
| `/mem-retain <prompt>` | Have the agent study something and store it to the bank now (works even with auto-memorize off). |
| `/mem-recall <query>` | Ad-hoc search of the memory bank. |
| `/mem-mark` | Mark everything up to now as processed (move the pointer, write nothing). |
| `/mem-auto [on\|off\|recall\|retain]` | Toggle the background contours **for this session**. No argument prints the current state; `on` / `off` switch both; a bare `recall` or `retain` toggles just that one, and `recall off` / `retain on` set it explicitly. Nothing is written to disk — use the `/mem` Settings tab to persist. |
| `alt+h` | Open the same panel straight from the keyboard. |

One CLI flag, for spawning agents that must stay silent:

| Flag | What it does |
| --- | --- |
| `--mem-only-tools` | Register the `hindsight_*` tools and nothing else — no widget, commands, hooks, timers, or automatic recall/retain (see below). |

Everything else that used to be its own command — fact categories, recall
effort, status, log, document review — now lives in the `/mem` panel's tabs.

### Panel navigation

The panel has two focus levels, so a list inside a tab can never swallow the
tab keys:

| Key | Where | What it does |
| --- | --- | --- |
| `←` / `→` / `Tab` / `Shift+Tab` | anywhere | Switch tab — works even from inside a list |
| `Enter` / `↓` | tab strip | Descend into the active tab's content |
| `Esc` | content | Back to the tab strip |
| `Esc` / `q` | tab strip | Close the panel |
| `r` | anywhere | Reload what the active tab shows |
| `↑` / `↓` | content | Move the cursor (settings row, document, log entry) |
| `Enter` / `Space` | Settings | Change the selected setting |
| `a` / `e` / `d` | Review | Approve / edit / delete the shown document |
| `PgUp` / `PgDn` | Review | Scroll a long document |
| `Enter` | Log | Expand the selected entry |

### Agent tools

The extension also registers tools the agent (and subagents) can call directly:
`hindsight_recall`, `hindsight_reflect`, `hindsight_retain`.

Injected memory appears in the chat as a `🧠 recall` block; a memory write shows
live on the widget (see below).

---

## What gets stored

Memory is **facts only, never invented** — extractive from the actual
conversation. Stored: goals, decisions with their rationale, standing
constraints/preferences, verified know-how, pitfalls (what was tried and
failed), and non-obvious facts & locations (paths, endpoints, env-var *names*,
ports).

Never stored: code diffs or raw tool output, assistant chatter, unexecuted
plans, status updates ("README updated…", "I will check…"), completed one-off
task goals, hedged guesses, transient details (line numbers, timestamps, run
ids), or **secret values** — only *where* a secret lives (env-var name, config
path) is kept.

Every candidate bullet must pass a **future-value test**: it is stored only if
a future agent knowing it would act differently — skip a re-discovery, avoid a
repeated failure, respect a standing constraint, or find something faster.
Most transcript slices contain nothing durable, and an empty result is a
normal outcome, not a failure.

All memory is written in one configured language (`memoryLanguage`, default
English) regardless of the conversation's language, so the same fact never
exists in two tongues and semantic search stays sharp. The `dedup` phase and
deterministic `document_id`s mean the same fact is not stored twice, even
across sessions.

### Fact categories (`/mem` → Settings)

*What* gets harvested is configurable. Each category is **tri-state**:

- `✓` **on** — extract it: its heading + guidance + example steer the extractor;
- `○` **off** — neutral: not mentioned at all (neither asked for nor forbidden);
- `✗` **ban** — explicitly excluded: the extractor is told to drop it.

| Category | Default | What it captures |
| --- | --- | --- |
| Goal | `✓` | The objective and its definition of done |
| Decisions | `✓` | Choices made + rationale / trade-offs |
| Constraints & preferences | `✓` | Standing user rules (style, always/never, tooling) |
| Know-how | `✓` | Verified procedures: commands, configs, fixes that worked |
| Pitfalls | `✓` | Approaches tried that FAILED, and why |
| Facts & locations | `✓` | Endpoints, ports, versions, env-var names, where secrets live |
| Code map | `○` | Which file/symbol holds what, module responsibilities |
| Domain knowledge | `○` | External / business facts, terminology |

Edit them in the `/mem` panel's **Settings** tab. State lives in
`.pi/hindsight.json` under `factCategories` and steers the write pipeline's
extraction.

### Recall effort (`/mem` → Settings)

Recall does not use categories. Instead it turns the user's question plus recent
context (`recallContextTokens`) into **several** bank queries from different
angles, picks the relevant hits, and — when set to *thorough* — asks follow-up
queries based on what it found, until it has enough or the query budget
(`recallMaxQueries`) runs out.

| Effort | Queries / round | Rounds | Feel |
| --- | --- | --- | --- |
| `light` | 1 | 1 | one quick lookup |
| `normal` (default) | 2–3 | 1 | a few angles, one pass |
| `thorough` | 3–4 | up to 3 | iterative: later rounds build on earlier hits |

---

## Widget legend

One fixed line: `🧠` · bank dot · bank id · auto-mode · bank size · last action.
The dot is `●` connected, `◐` checking, `○` not checked yet, `⟳` working; when
the bank is unreachable its complaint replaces the size and the action.

The action tail (truncated from the right in a narrow terminal):

```
↙ waiting for bank… (clears on reply)   lookup in flight; Esc cannot cancel it
↙ recall · 12→3 · <query>                found 12, injected 3 (rest already seen)
↙ recall · nothing found · <query>       looked, bank had nothing relevant
↙ reflect · answered · <query>           bank composed a direct answer
↙ skipped (reason)                      no lookup (meta-question / chit-chat)

↗ <reason> → memory                     memorize started on that trigger
↗ stored 1 doc · 9 lines                written to the bank
↗ nothing new to store                  the slice had nothing durable / all known
↗! <error>                              the write failed
```

---

## Development

```bash
bun install          # dev types only; pi provides the runtime packages
npx tsc --noEmit     # type-check
```

Source lives in `src/`; the runtime entry is `.pi/extensions/hindsight.ts`
(a 3-line re-export). After editing `src/`, just `/reload` in pi — no build step.

---

## License

MIT — see [LICENSE](./LICENSE).
