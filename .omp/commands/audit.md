---
description: Dialectic codebase architecture and security audit with line-level proof
---

Run the IUMBTEMS dialectic codebase audit on `$1`:

`python3 runner/research_swarm.py --mode audit --objective "$1"`

Report: `.research/code_audit_report.md` with `file:///path#Lstart-Lend` pointers
and verbatim snippets. Every vulnerability needs a concrete patch blueprint.
