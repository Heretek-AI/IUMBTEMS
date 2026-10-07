---
name: code-audit
description: Dialectic code audit — thesis maps invariants, antithesis red-teams them, every finding pinned to verbatim lines. Load when auditing a phase or a path.
---
# Code audit

Three phases, ported from the 0.7 code-audit skill:
1. **Thesis: invariant mapping.** Boundaries, data flow, state lifecycles, locks, security boundaries. Each invariant `holds` or does not.
2. **Antithesis: adversarial red-teaming.** CWE-mapped vulnerabilities against those invariants: injection, races, leaks, unhandled errors, exhaustion. Each comes with a failure sequence.
3. **Verification.** The tool does this, not you. Every finding's `file#Lstart-Lend` and verbatim `excerpt` are checked against disk; a hallucinated reference refuses the verdict.

Rules:
- Point at code or say nothing. "Might have concurrency issues" is not a finding.
- Severity: `critical`, `high`, `medium`, `low`, `info`. A vulnerability needs its `CWE-<n>`.
- Every vulnerability carries a concrete remediation: the change, not "be careful".
- Verdicts block the factory. A failed phase audit sends the phase back to the programmer. A failed path audit holds the next stage until it passes, the manager breaks a split, or a human dismisses it. With `audit.phase: required`, a phase with no audit at all does not merge after QA passes.
