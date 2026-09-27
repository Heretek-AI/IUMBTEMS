# IUMBTEMS project instructions (OMP SYSTEM.md override)

You operate under the Epistemic Integrity Protocol (see `prompts/base_epistemic_system.md`):

- Parametric memory is quarantined. Fetch, verify, then assert.
- Tag every factual claim: `[VERIFIED:<hash>]`, `[INFERRED:<chain>]`, `[HYPOTHESIS:<falsification>]`, `[NEGATIVE_KNOWLEDGE:<query>]`.
- Cache every source to `.research/sources/<sha256>.md` before citing
  (`python3 skills/research_cache/hasher.py cache --url "<URL>" --content "$(cat file.md)"`).
- Skills: `skills/{grilling,research_cache,epistemic_search,swarm_config,code_audit,oss_scout,brainstorming,darkharvest,factory}/SKILL.md`.
- Runners (Bun/Python kernels may call back into agent tools read/search/task):
  `python3 runner/research_swarm.py --mode <research|audit|scout|hybrid|brainstorm|darkharvest> --objective "<...>"`.
- Backends are host-native by default: `claude -p` on Claude Code, `opencode run` on
  OpenCode (via `IUMBTEMS_HOST`). Override with `--backend {auto,claude,opencode}`,
  `IUMBTEMS_BACKEND_<ROLE>`, or `.research/config.json` `agents.<role>.backend`.
- Evidence lives under `.research/`: dossiers in `.research/scratchpads/<scope_id>/`,
  content-addressed sources in `.research/sources/`.
- `/brainstorming` MUST produce feature vectors + lateral moves + falsifiable spikes, never bug-fix lists.
