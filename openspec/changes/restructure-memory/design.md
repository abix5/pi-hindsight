# Design

## Context

See proposal.md for motivation. Three facts about the existing code shape every
decision below.

The extension runs inside pi with no build step: pi loads `src/index.ts`
directly. Everything here is TypeScript checked by `make check`, which also runs
every `scripts/*.test.ts` registered in the Makefile. Current baseline is 569
PASS / 0 FAIL.

The prompt cache dominates cost. Measured on this project's own sessions
(`~/.pi/agent/sessions/*.jsonl`, field `usage`), a cache write costs 11.9–13.9×
a cache read, so any byte that changes between turns inside the system prompt
re-prices the whole prefix. This is why the extension already has an epoch
mechanism — a block is read once at `session_start` or after a successful
`session_compact`, frozen in extension memory, and reused unchanged until the
next boundary — and why the memory contract must ride that same mechanism rather
than being appended per turn.

`hindsight_recall` is today a single `POST /recall` whose response is flattened
to `text` only. The server returns far more per hit (`mentioned_at`,
`occurred_start`, `type`, `tags`, `entities`, `document_id`; confirmed against
the live `GET /openapi.json`), and the server also exposes `POST /reflect`,
which synthesizes an answer in one pass with no opportunity to follow up.

## Goals / Non-Goals

**Goals:**

- One formatter for facts, used by every path, so the two printing sites cannot
  drift apart.
- A delegation that can ask more than one question of the banks, under hard
  limits, without spawning a process or adding a turn.
- A migration for `autoRecall` that changes nobody's behaviour silently.

**Non-Goals:**

- Streaming the librarian's progress into the result block. The person sees one
  activity line; the trail belongs to the journal.
- Replacing the server's `reflect` with our own synthesis. It stays available as
  a first draft the librarian may take.
- Touching the widget, the task detector, the invalidation path, the review
  queue, or the write-hygiene rules. None of them are in scope.

## Decisions

**The librarian runs on pi's own agent loop, not on a spawned process and not on
a hand-written loop.** `runAgentLoop` from `@earendil-works/pi-agent-core` takes
`{ systemPrompt, messages, tools }` and a stream function; `streamSimple` from
`pi-ai` satisfies the latter. The alternative in pi's own examples — spawning
`pi --mode json` as a subagent — costs a process and a second model context for
work that must feel like one tool call. Writing our own loop would mean
reimplementing tool dispatch and message threading that already exist and are
maintained.

**The delegation is synchronous.** A pi tool's `execute` blocks until it
returns, and the main agent waits. A background variant would have to deliver
its answer through `sendMessage` plus `triggerTurn`, which means a second turn
and an extra message in the context — precisely what this project rejected when
it removed taskflow.

**The librarian gets four tools and nothing else**: a synthesized draft from a
bank (at most once per bank, because a second draft answers the same question
with the same one-pass weakness), a targeted search, a source-document read for
when a fact is visibly truncated, and a terminating answer. Anything broader
invites the librarian to wander; anything narrower makes it no better than the
single request it replaces.

**Limits are honest, not silent.** On the step limit the tool returns the facts
from the last completed search with the summary explicitly marked missing.
Returning nothing would hide that memory did have material; returning a summary
the librarian never wrote would be a lie.

**The fact's bank is passed in by the caller, never inferred.** The client that
answered knows which bank it is; a tag-based guess would be wrong exactly when
the banks share a tag.

**Missing metadata is printed as a placeholder.** Positions stay put, so a
reader — human or model — can scan a column instead of parsing each line.

**The default for `autoRecall` is decided by measurement, not by taste.** The
slice that builds the librarian must report the median cost of a delegation over
ten real questions. If that median is at or below $0.02, the default becomes
boundaries; above it, the default stays every turn, because a cheap automatic
injection beats an expensive one the agent must remember to request.

**Configuration keeps its old values working.** The loader accepts the boolean
form from every source (environment, global file, project file) and maps it, so
an installation that set `autoRecall` years ago behaves identically after the
upgrade.

## Risks / Trade-offs

The librarian's message conversion is unverified. `AgentLoopConfig` requires a
`convertToLlm`, and whether an identity conversion survives tool-result messages
will only be known on the first live run → start with identity, fix at that
point, and report what was required rather than guessing now.

A delegation is slower than a single request — seconds instead of hundreds of
milliseconds → it is never on the turn path, only on an explicit question, and
the activity line tells the person it is running.

Retreating automatic recall to boundaries relies on the agent actually asking →
the contract instructs it to, and the periodic reminder keeps the tool in view;
the measurement gate above prevents shipping the retreat if the delegation turns
out to be expensive.

Two trackers describe the same work — beads issues and this change's `tasks.md`
→ each task names its bead id, and the beads issue is the state of record; the
checklist is the apply-phase progress marker only.

## Migration Plan

`autoRecall` is read through a parser that accepts three names and two booleans.
No file is rewritten on upgrade: an old value is mapped on every load, so
downgrading the extension leaves the configuration valid. The release notes say
plainly that a configured installation changes nothing.

## Open Questions

None that would change the specs, the approach or the task breakdown. Two
decisions are deliberately deferred to evidence produced inside the work: the
shipped default for `autoRecall` (decided by the measured median cost) and the
exact `convertToLlm` shape (decided by the first live run).
