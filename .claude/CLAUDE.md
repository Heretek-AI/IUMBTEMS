# IUMBTEMS (Epistemic Swarm): Project Workspace Rules

This repository operates under the **IUMBTEMS Epistemic Integrity Protocol**. All Claude Code sessions within this directory are bound by strict evidentiary integrity rules.

## Core Rules for This Workspace
1. **Epistemic Invariant Enforcement**:
   - Tag every factual claim using `[VERIFIED: <hash|URL>]`, `[INFERRED: <reasoning>]`, `[HYPOTHESIS: <test>]`, or `[NEGATIVE_KNOWLEDGE: <query>]`.
   - Never generate hallucinated citations. If an empirical claim cannot be retrieved and verified via tools, mark it as `[HYPOTHESIS]` or `[NEGATIVE_KNOWLEDGE]`.

2. **Source Caching**:
   - When fetching articles, documentation, or papers via web search or MCP tools, ensure the raw content is hashed and saved to `.research/sources/<sha256>.md` with metadata in `.research/sources/<sha256>.json`.
   - Verbatim quotes must match the text inside `.research/sources/<sha256>.md`.

3. **Multi-Agent Dialectic Swarm**:
   - When running deep research, use the runner script:
     ```bash
     python3 runner/research_swarm.py --mode <research|audit|scout|hybrid|brainstorm|darkharvest> --objective "<Research Question>"
     ```
   - For preliminary planning and assumption inversion, trigger the Socratic grilling skill via `/grilling`.

4. **IPC Scratchpad Structure**:
   - Read and write session data strictly through `.research/scratchpads/{scope_id}/`.
