---
description: Run dialectic codebase architectural and security audit with line-level proof
---

Run an IUMBTEMS dialectic codebase audit (structural architect vs adversarial red-teamer).

Target: $ARGUMENTS (path, component, or empty for full-repository architecture and vulnerability audit)
If $ARGUMENTS names a path that does not exist, ask the user to clarify the target first; never audit a placeholder path.

1. Execute `iumbtems_code_audit` with `{"target": "<target>"}` (or `python3 runner/research_swarm.py --mode audit --objective "$ARGUMENTS"`).
2. Summarize `.research/code_audit_report.md` with line-level proof pointers (`file:///path#Lstart-Lend`) and concrete remediation blueprints.
