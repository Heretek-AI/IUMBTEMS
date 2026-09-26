---
name: code-audit
description: Deep dialectic codebase auditing skill. Deploys architectural thesis vs adversarial red-team antithesis to discover security vulnerabilities, race conditions, resource leaks, and architectural flaws with exact line-level proof.
---

# Dialectic Codebase Audit Engine

Perform exhaustive, evidence-backed security, performance, and architectural audits of codebases.
Unlike superficial linting or single-pass code reviews, this skill pairs a **Structural Architect (Thesis)** with an **Adversarial Red-Teamer (Antithesis)** to rigorously stress-test codebase assumptions.

## 1. Invoking a Codebase Audit

Audit the entire repository:
```bash
iumbtems audit "Full repository architecture and vulnerability audit"
```
Or via npx:
```bash
npx @heretek-ai/epistemic-swarm audit "Audit runner/ and skills/ for concurrency and injection vectors"
```
Or directly with the python runner:
```bash
python3 runner/research_swarm.py --mode audit --objective "Audit security boundaries and memory lifecycle"
```

## 2. Dialectic Audit Protocol

1. **Phase 1: Architectural Invariant Mapping (Alpha)**
   - Maps module boundaries, call graphs, state transition lifecycles, and synchronization locks.
   - Extracts invariants and documents design guarantees with line pointers: `[PATH: src/auth.py#L45-L60]`.

2. **Phase 2: Adversarial Red-Teaming (Beta)**
   - Actively searches for exploit vectors: injection flaws (CWE-78, CWE-89), race conditions (CWE-362), unhandled error paths, resource exhaustion, and memory leaks.
   - Constructs concrete proof-of-concept failure sequences attacking Alpha's assumed invariants.

3. **Phase 3: Epistemic Code Verification**
   - Mathematically verifies that all cited files and lines exist on disk and accurately reproduce the target code.
   - Penalizes speculative or hallucinated line references.
   - Produces `.research/code_audit_report.md` and `.research/code_audit_dossier.json`.

## 3. Evidence Standards

- **Strict Line Pointers**: Every vulnerability or architectural observation must specify `file:///path/to/file#L<start>-L<end>`.
- **Verbatim Snippets**: Code excerpts must match the local repository verbatim.
- **Actionable Remediation**: Every vulnerability must include a concrete patch diff or refactoring blueprint.
