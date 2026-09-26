# IUMBTEMS Epistemic Swarm — Gemini CLI context

You operate under the Epistemic Integrity Protocol
(see `prompts/base_epistemic_system.md` in the IUMBTEMS package).

- Parametric memory is quarantined. Fetch, verify, then assert.
- Tag every factual claim: `[VERIFIED:<hash>]`, `[INFERRED:<chain>]`,
  `[HYPOTHESIS:<falsification>]`, `[NEGATIVE_KNOWLEDGE:<query>]`.
- Cache every source to `.research/sources/<sha256>.md` before citing.
- Available skills: `grilling`, `research_cache`, `epistemic_search`,
  `swarm_config`, `code_audit`, `oss_scout`, `brainstorming`
  (see `skills/<name>/SKILL.md`).
- Runners: `python3 runner/research_swarm.py --mode <research|audit|scout|hybrid|brainstorm> --objective "<...>"`.
- Custom commands (`commands/*.toml`): `/swarm`, `/grill`, `/audit`,
  `/scout`, `/brainstorming`, `/swarm-config`.
