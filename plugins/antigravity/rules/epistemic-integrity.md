# Epistemic Integrity Invariant (AntiGravity Workspace Rule)

## Evidence-First Invariant
Every factual claim made by any agent MUST carry an empirical attribution tag:
- `[VERIFIED: <sha256>]`: Verbatim quote matching content in `.research/sources/<sha256>.md`.
- `[INFERRED: <parents>]`: Logical derivation explicitly citing verified parent claims.
- `[HYPOTHESIS: <test>]`: Falsifiable proposition paired with an empirical verification test.
- `[NEGATIVE_KNOWLEDGE: <query>]`: Recorded failure or absence of evidence for a specific query.

Never present unverified parametric recollection as fact. Quarantined parametric recall must be verified against cached sources before assertion.

## Directory Isolation & Write Boundaries
- Agents write ONLY to `.research/` (evidence, dossiers, retrieval logs), `.factory/` (runtime execution state), and `.roadmap/` (phase outputs).
- Never modify existing dossiers in-place; dossiers form an immutable historical record.
- Claim status transitions must be appended to `.research/ledger/claim_status.json`.
- Never install external dependencies or packages without explicit user authorization.
