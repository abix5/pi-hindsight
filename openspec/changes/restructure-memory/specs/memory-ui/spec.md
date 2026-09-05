## Purpose

Defines what the person sees while memory is being searched on their behalf,
what they see once it answers, and where the searcher's individual steps and
their cost are recorded for the times when someone needs to debug them.

## ADDED Requirements

### Requirement: A running search is visible while it runs

While a delegated search is in progress the system SHALL show, in the harness's
existing activity line, that memory is working, which question is being asked
and how far along the search is. When the search ends the line SHALL be restored
to the harness's own default.

#### Scenario: Restored on every outcome

- **WHEN** a search ends by answering, by reaching its step limit, by failing,
  or by being cancelled
- **THEN** in each case the activity line is returned to the harness default,
  as the last thing the search does

#### Scenario: Progress is visible

- **WHEN** the search completes a step
- **THEN** the activity line reflects the new step count

### Requirement: The answer is shown, the trail is not

The result the person sees SHALL carry the question, the outcome, the number of
steps, the number of facts, the elapsed time, and — when opened — the written
answer followed by the facts with their provenance. It MUST NOT contain the
searcher's individual tool calls in either the closed or the opened form.

#### Scenario: Closed form

- **WHEN** a completed search is shown without being opened
- **THEN** a single line reports the question, the outcome, the step count, the
  fact count and the elapsed time

#### Scenario: Opened form

- **WHEN** the same result is opened
- **THEN** it shows the written answer and the facts
- **AND** it names none of the searcher's individual steps

#### Scenario: Limit and failure are distinguishable

- **WHEN** the search ended at its step limit, or failed
- **THEN** the outcome shown says which of the two happened, and a failure names
  its error

### Requirement: Steps and cost are recorded in the journal

Each delegated search SHALL append one journal entry carrying the question, the
facts found and returned, every step the searcher took with its bank, its
argument, its outcome and its duration, and the monetary cost of the delegation
when the model reported enough usage to compute it.

#### Scenario: Journal row and its expansion

- **WHEN** the person opens the journal and expands the entry for a search that
  took three steps
- **THEN** the row shows the step count and the cost
- **AND** the expansion shows one line per step

#### Scenario: Unknown cost

- **WHEN** the model reported no usage
- **THEN** the entry records no cost and the row shows a placeholder instead of
  a number

### Requirement: Nothing else is disturbed

A delegated search SHALL change no surface other than the activity line, its own
result and the journal. It MUST raise no notification and MUST place no
additional message into the conversation.

#### Scenario: A search runs and finishes

- **WHEN** a delegated search runs to completion
- **THEN** no notification is raised and no additional message enters the
  conversation
- **AND** no surface other than the activity line, the result and the journal
  changes
