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

A small status widget shows both contours live:

```
🧠 ● pi-hindsight · auto ↙↗ · 16 docs · 153 facts
↙ recall · db migration command · found→injected
```

Auto-mode markers: `↙` = recall, `↗` = retain, `auto off` = both disabled.

---

## How it works

### Recall (read path — inline)

Runs on the `before_agent_start` hook. A cheap model turns the recent
conversation into a bank query and decides whether a lookup is even worth it
(meta-questions and chit-chat are skipped). Matching facts are fetched, de-duped
against facts already injected this session, and returned as an *untrusted
reference* block for the current turn. Nothing is rewritten or invented — facts
are injected verbatim and the main model weaves them in.

Two operations are supported:

- `recall` (default) — return the raw relevant facts.
- `reflect` — ask Hindsight to compose a direct answer from the bank, used only
  for self-contained factual questions.

### Memorize (write path — taskflow)

Triggered on context compaction, the manual `/mem-save` command, and — as a
last-chance safety net — when a session is **quit or replaced by `/new`** (so an
un-memorized tail is not lost). It is **never** triggered by `/reload` (nothing
is lost there). Compaction and manual writes are fire-and-forget (the agent
never waits); the session-close write runs inline and is awaited before the
process exits, bounded by a 60s cap so quitting can never hang.

The write is a deterministic [taskflow](https://github.com/earendil-works/pi)
(`taskflows/memory-fill.json`) with four phases:

1. **build** *(agent)* — reads the compacted delta and writes a short, extractive
   *report* of durable knowledge (decisions + rationale, constraints, verified
   know-how, pitfalls, facts & locations). Emits `NONE` if nothing is durable.
2. **stage** *(script)* — writes the report to a per-run file and queries the
   bank via `curl` for anything already stored on the topic.
3. **dedup** *(agent)* — drops every bullet already present in the bank, keeps
   only what is new or changed.
4. **store** *(script)* — `curl`-POSTs the surviving report to the bank
   (`async`), then deletes the scratch file.

Every write carries a **deterministic `document_id`** derived from the session
and the exact transcript window (`pi-` + sha256 of session + first/last entry
id). Re-ingesting the same window — a retried flow, a repeated flush — *upserts*
the existing document in the bank instead of piling up duplicates. Each
dispatched window is also recorded in an append-only journal
(`.pi/hindsight/dispatch-log.jsonl`), which is what lets `/mem-resave` first
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

Bank I/O lives in the **script** phases (plain `curl`), not in subagents — so it
never depends on a subagent having the right tools, and no model sits in the
write path to derail it.

### Review (`/mem-review`)

Documents are stored to the bank **immediately** (so dedup and recall always
work against fresh knowledge), and every stored document is also placed in a
**global review queue** (`~/.pi/hindsight/review-queue.jsonl`, shared across
all projects). `/mem-review` starts a small local web UI (127.0.0.1, ephemeral
port, opened in your browser) where you can go through everything the agent has
written — across every project — and:

- **Approve** — you are done with it; removes it from the queue (the bank is
  untouched).
- **Edit** — fix the text in place; the document is re-stored under the *same*
  `document_id`, so the bank replaces the old facts with the corrected ones.
- **Delete** — remove the document and its facts from the bank entirely.

Queue entries whose document never made it to the bank (a run that produced
nothing durable) are dropped automatically. The queue is an append-only event
log, so parallel pi sessions can write to it safely; `/mem-review stop` shuts
the server down (it also closes on session end).

### Pointers & `/mem-remember`

Two markers track memory, answering different questions:

- **Watermark** — *how far through the transcript* has been memorized. It only
  moves forward; the next write resumes right after it. `/mem-mark` advances it
  to now **without writing** (mark everything so far as already processed).
- **Saved ranges** — *which blocks were already stored out-of-band* by
  `/mem-remember`. `/mem-remember <prompt>` hands the agent a study task; the
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
- **pi-taskflow** for the recommended `memorizeEngine: "taskflow"` path. The npm
  package is installed as a dependency, but the taskflow extension/tool must also
  be available to pi so the agent can run the `taskflow` tool. Use
  `memorizeEngine: "inline"` only if you intentionally want no taskflow runtime.
- A running **Hindsight** HTTP API — by default `http://localhost:8888`,
  namespace `default`. On macOS, the easiest way to get one is
  [**hindsight-setup**](https://github.com/abix5/hindsight-setup).
  **v0.8.4+** recommended: recall uses `prefer_observations` (provenance-based
  dedup of raw facts superseded by observations). Older servers just ignore the
  flag — no error, but no server-side dedup either.
- **bun** — the extension runs as TypeScript.
- **jq** and **curl** on `PATH` — used by the memorize taskflow's script phases.
- **Two models** available in your pi model registry (one cheap for
  recall/build, one slightly stronger for dedup). See *Configuration*.

---

## Install

pi auto-discovers `.pi/extensions/*.ts` in a trusted project. To add pi-hindsight
to a project:

1. **Install the packages**:

   ```bash
   npm install -D @abix5/pi-hindsight pi-taskflow
   ```

   `@abix5/pi-hindsight` also declares `pi-taskflow` and the pi runtime packages
   as dependencies, so npm installs the code needed for module resolution. The
   explicit `pi-taskflow` install keeps the required pi extension visible in the
   consuming project.

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

3. **Register the taskflow.** Point your project `package.json` at the packaged
   taskflow directory:

   ```json
   { "pi": { "taskflows": ["./node_modules/@abix5/pi-hindsight/taskflows"] } }
   ```

   For a local clone, either copy `taskflows/memory-fill.json` into your
   project's `.pi/taskflows/`, or point at the clone's `taskflows/` directory.

4. **Set your models** in the active `memory-fill.json`. The `build` and `dedup`
   phases have `"model": "..."` fields — change them to models you actually have.

5. **Create `.pi/hindsight.json`** (see below), trust the project, then
   `/reload` in pi.

6. Verify the bank connection with `/mem-status`.

---

## Configuration

Settings are read from environment variables, then overridden by
`.pi/hindsight.json` in the project (handy for hot `/reload`). A typical config:

```json
{
  "autoRecall": true,
  "autoMemorize": true,
  "memorizeEngine": "taskflow",
  "retainModelId": "your/build-model",
  "recallModelId": "your/recall-model",
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

| Key | Env | Default | Meaning |
| --- | --- | --- | --- |
| `baseUrl` | `HINDSIGHT_BASE_URL` | `http://localhost:8888` | Hindsight API base URL |
| `namespace` | `HINDSIGHT_NAMESPACE` | `default` | API namespace (path after `/v1`) |
| `bankId` | `HINDSIGHT_BANK` | project folder slug | Memory bank id |
| `autoRecall` | `HINDSIGHT_AUTO_RECALL` | `true` | Search memory before each turn |
| `autoMemorize` | `HINDSIGHT_AUTO_MEMORIZE` | `true` | Write memory on compaction and session close (toggle per-session with `/mem-auto`) |
| `memorizeEngine` | `HINDSIGHT_MEMORIZE_ENGINE` | `inline` | `taskflow` (recommended) or `inline` |
| `recallModelId` | `HINDSIGHT_RECALL_MODEL` | pi default | Cheap model for query-building / filtering |
| `retainModelId` | `HINDSIGHT_RETAIN_MODEL` | pi default | Model for the inline write pipeline |
| `recallOperation` | `HINDSIGHT_RECALL_OPERATION` | `recall` | `recall` (facts) or `reflect` (answer) |
| `recallEffort` | `HINDSIGHT_RECALL_EFFORT` | `normal` | Recall thoroughness: `light` / `normal` / `thorough` (set via `/mem-effort`) |
| `recallMaxQueries` | `HINDSIGHT_RECALL_MAX_QUERIES` | `8` | Hard ceiling on total bank queries per recall |
| `factCategories` | — | all on except code/domain | Tri-state map of which categories to extract (set via `/mem-types`) |
| `recallFilter` | `HINDSIGHT_RECALL_FILTER` | `model` | `model` (LLM-picked) or `off` |
| `recallMaxLines` | `HINDSIGHT_RECALL_MAX_LINES` | `8` | Max facts injected per turn |
| `recallContextTokens` | `HINDSIGHT_RECALL_CONTEXT_TOKENS` | `5000` | Recent context budget for the query |
| `memoryLanguage` | `HINDSIGHT_MEMORY_LANGUAGE` | `en` | Language all stored memory is written in (code identifiers stay verbatim) |
| `retainMission` | `HINDSIGHT_RETAIN_MISSION` | engineering-focused | Bank-side extraction mission, synced to the bank at startup |
| `observationsMission` | `HINDSIGHT_OBSERVATIONS_MISSION` | engineering-focused | Bank-side observation-consolidation mission, synced at startup |
| `dispatchLogPath` | `HINDSIGHT_DISPATCH_LOG_PATH` | `.pi/hindsight/dispatch-log.jsonl` | Journal of stored documents (powers `/mem-resave` cleanup) |
| `countsRefreshMs` | `HINDSIGHT_COUNTS_REFRESH_MS` | `20000` | Widget counter refresh interval |
| `debug` | `HINDSIGHT_DEBUG` | `false` | Verbose logging (full prompts/bodies) — **may leak sensitive data** |

> The `taskflow` engine uses the models set inside `memory-fill.json`, not
> `retainModelId`. `retainModelId` only applies to the `inline` engine.

---

## Commands & shortcuts

| Command | What it does |
| --- | --- |
| `/mem-save` | Save the accumulated context to memory now |
| `/mem-resave` | Re-collect the **whole** session (deletes this session's previously stored documents first, then re-ingests) |
| `/mem-review [stop]` | Open the browser review UI — approve / edit / delete stored documents across all projects |
| `/mem-remember <prompt>` | Have the agent study something and store it now |
| `/mem-recall <query>` | Ad-hoc search of the memory bank |
| `/mem-mark` | Mark everything up to now as processed (move the pointer, write nothing) |
| `/mem-auto [on\|off]` | Toggle **both** auto-recall & auto-retain (or `/mem-auto recall\|retain on\|off` for one; bare `/mem-auto` shows state) |
| `/mem-types` | Pick which fact categories to extract — tri-state checklist (`✓` extract · `○` neutral · `✗` exclude); also `/mem-types <key> on\|off\|ban` |
| `/mem-effort [light\|normal\|thorough]` | How thorough recall is — how many bank queries / refine rounds it spends |
| `/mem-log` · `alt+h` | Open the memory operation history |
| `/mem-status` | Health check, bank, pointer position, and toggle state |
| `/mem-model [prompt]` | Resolve the small model and run a tiny completion |

### Agent tools

The extension also registers tools the agent (and subagents) can call directly:
`hindsight_recall`, `hindsight_reflect`, `hindsight_retain`.

Injected memory appears in the chat as a `🧠 recall` block; a memory write shows
live on the widget's second line (see below).

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

### Fact categories (`/mem-types`)

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

Add your own from the picker (`+ Add custom type`) or with `/mem-types <key> on`. State lives in
`.pi/hindsight.json` under `factCategories` and applies to both the inline and
taskflow write paths.

### Recall effort (`/mem-effort`)

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

Two fixed lines. Line 1 is the bank and its counts; line 2 is the live
lifecycle of the current operation.

```
↙ recall · <query> · found→injected      memory found and injected this turn
↙ recall · <query> · nothing found        looked, bank had nothing relevant
↙ reflect · <query> · answered            bank composed a direct answer
↙ skipped (reason)                         no lookup (meta-question / chit-chat)

building doc…                              memorize: extracting the report
doc ✓ · dedup -2 · sending to bank…        2 known bullets dropped, storing rest
doc ✓ · dedup ✓ · bank ✓ · +1              stored one new document
doc ✓ · dedup ✓ · nothing new (all known)  everything was already remembered
doc ✗ (nothing durable to store)           the slice had no reusable knowledge
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
