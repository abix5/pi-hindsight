## Purpose

Defines which memory holds what — decisions about this project versus standing
facts about the person working on it — how the agent is told the difference, and
how every block the extension puts in front of the model declares which bank it
came from.

## ADDED Requirements

### Requirement: Two banks with disjoint subject matter

The extension SHALL address two independent banks: a PROJECT bank, holding
decisions, constraints, procedures and dead-ends bound to the current project,
and a USER bank, holding standing facts about the person that remain true in any
project. Each bank SHALL be reachable through its own write tool, and the USER
bank SHALL be optional.

#### Scenario: A user bank is configured

- **WHEN** a user bank is declared in configuration
- **THEN** the tool that writes standing facts about the person is available
- **AND** the tool that writes project facts remains available

#### Scenario: No user bank is configured

- **WHEN** no user bank is declared
- **THEN** the tool that writes standing facts about the person is not offered
  at all
- **AND** the project bank continues to work unchanged

### Requirement: The agent is told which memory is which

The system SHALL place a standing memory contract in the agent's instructions.
The contract MUST state what the project bank holds, what the user bank holds,
the one-sentence test that separates them — "would this still be true in a
completely different project?" — and that the agent is expected to ask memory
before non-trivial work rather than guess.

#### Scenario: Contract names the configured banks

- **WHEN** the contract is placed for a project whose banks are named
- **THEN** the text names both banks by their configured identifiers

#### Scenario: The user half is conditional

- **WHEN** no user bank is configured
- **THEN** the contract contains the project half and the instruction to ask
  memory
- **AND** it contains no paragraph about a user bank

#### Scenario: An inactive project gets no contract

- **WHEN** the current project declares no bank at all
- **THEN** no contract is placed

### Requirement: The contract never invalidates the prompt cache

The contract SHALL be decided once per epoch, where an epoch begins at session
start and after a successful compaction, and SHALL be byte-identical on every
turn within one epoch.

#### Scenario: Identical across turns

- **WHEN** a session runs ten consecutive turns without compaction
- **THEN** the instruction text is byte-identical on all ten turns
- **AND** it appears exactly once

#### Scenario: Re-decided at a boundary

- **WHEN** the configured bank changes and a compaction completes
- **THEN** the next epoch's contract names the new bank

### Requirement: Every block declares the bank it came from

Any block of remembered content the extension places in front of the model
SHALL name its source bank. A block assembled from the user bank MUST open with
a line naming that bank; a recalled fact MUST carry its bank in the fact's own
line.

#### Scenario: The user block is signed

- **WHEN** a block is assembled from the user bank
- **THEN** its first line names that bank
- **AND** the whole block, including that line, stays within the block's size
  limit

#### Scenario: The signature does not drift

- **WHEN** the same content is assembled twice within one epoch
- **THEN** both blocks are byte-identical
