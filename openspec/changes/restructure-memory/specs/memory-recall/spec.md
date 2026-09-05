## Purpose

Defines how a question addressed to memory is answered: what a returned fact
looks like, how the search is carried out on the asker's behalf, and what
happens when it runs long, hits its limits or fails.

## ADDED Requirements

### Requirement: A returned fact carries its provenance

Every fact the extension shows SHALL be accompanied by the bank that produced
it, the date it refers to, its type, its tags and its entities, in one fixed
arrangement used by every path that prints facts. A field the bank did not
supply MUST be rendered as an explicit placeholder rather than omitted, so the
arrangement never shifts.

#### Scenario: A fact with full metadata

- **WHEN** a fact is returned carrying a date, a type, tags and entities
- **THEN** all of them are shown alongside the fact's text
- **AND** the bank that produced it is named

#### Scenario: A fact with nothing but text

- **WHEN** a fact is returned with no date, type, tags or entities
- **THEN** each missing field is shown as a placeholder in its usual position
- **AND** the fact's text is shown unchanged

#### Scenario: Occurrence beats mention

- **WHEN** a fact carries both the date it is about and the date it was recorded
- **THEN** the date it is about is the one shown

#### Scenario: One arrangement everywhere

- **WHEN** the same fact is returned through an agent's explicit question and
  through an automatic injection
- **THEN** its line is identical in both

### Requirement: A question is answered by a delegated search

The system SHALL answer an agent's question to memory by delegating to a
separate, cheaper model that searches on the asker's behalf. That searcher SHALL
be able to obtain a synthesized draft from a bank, run targeted searches against
a bank, read the source document behind a fact, and finish by returning an
answer. It MUST return a written answer together with the facts it relied on.

#### Scenario: Draft, then targeted search, then answer

- **WHEN** the searcher takes a draft from a bank, runs one targeted search and
  finishes
- **THEN** the caller receives the written answer and the facts, each carrying
  its provenance
- **AND** the individual search steps are recorded

#### Scenario: A repeated draft is refused

- **WHEN** the searcher asks the same bank for a second synthesized draft
- **THEN** the request is refused with a reason
- **AND** no request reaches that bank

#### Scenario: The asker chooses which banks may be searched

- **WHEN** a question is scoped to the project bank only
- **THEN** an attempt to search the user bank is refused
- **AND** the refusal names the scope

#### Scenario: The user bank cannot be searched when absent

- **WHEN** no user bank is configured and the searcher addresses it
- **THEN** the attempt is refused with a reason

### Requirement: The search is bounded and degrades honestly

The delegated search SHALL stop after a configured number of steps or a
configured time limit. On reaching either limit the system MUST still return the
facts gathered so far, marked as lacking a summary, rather than returning
nothing.

#### Scenario: Step limit reached

- **WHEN** the searcher exceeds the allowed number of steps without finishing
- **THEN** no further step is executed
- **AND** the caller receives the facts from the last completed search, marked
  as having no summary

#### Scenario: Cancellation

- **WHEN** the caller cancels while the search is running
- **THEN** the search stops promptly
- **AND** no further request is sent to any bank

### Requirement: A failing model is retried down the chain

The system SHALL retry the delegated search on the next model in the configured
chain when the current one fails for a reason other than cancellation. When
every candidate has failed, the error returned to the caller MUST name each
model that was tried.

#### Scenario: Second candidate succeeds

- **WHEN** the first model fails and the second completes the search
- **THEN** the caller receives a normal answer

#### Scenario: All candidates fail

- **WHEN** every model in the chain fails
- **THEN** the caller receives one error naming every model that was tried
