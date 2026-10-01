---
name: swarm-config
description: Dynamic configuration and settings skill for the IUMBTEMS (Epistemic Swarm) research harness. Manage search engines, research depth, dialectic iterations, operating modes (research, audit, scout, hybrid, brainstorm, darkharvest), agent backends, and license filters.
---

# IUMBTEMS Configuration & Parameter Tuning

Use this skill to inspect, tune, and persist research parameters into `.research/config.json`.
Settings are automatically loaded by the Swarm Runner, Epistemic Auditor, and CLI.

## 1. Interactive Configuration

To launch the interactive configuration prompt:
```bash
python3 skills/swarm_config/configure.py --interactive
```

This guides you through selecting:
1. **Primary Search Engine**:
   - `duckduckgo` (Default, zero API key required, completely private)
   - `brave` (Brave Search API for high-precision SERP results)
   - `firecrawl` (Deep web scraping & JavaScript rendering)
   - `searxng` (Self-hosted privacy metasearch aggregator)
2. **Research Depth & Dialectic Iterations**:
   - `1` (Rapid brief, minimal token usage)
   - `2` (Standard thesis vs. antithesis dialectic - recommended)
   - `3` (Deep multi-pass verification)
   - `4` (Exhaustive multi-scope investigation)
3. **Operating Mode**:
   - `research` (Empirical literature & web synthesis)
   - `audit` (Deep codebase architecture, security, and vulnerability red-teaming)
   - `scout` (Open-source software discovery & clean-room harvesting)
   - `hybrid` (Combined codebase audit + web research)
   - `brainstorm` (Lateral creative ideation & what-if exploration)
   - `darkharvest` (Product competitor teardown & clean-room harvest)

## 2. Direct CLI Configuration

Inspect the current active configuration:
```bash
python3 skills/swarm_config/configure.py --show
```
or via CLI:
```bash
iumbtems config
```

Update parameters directly via flags:
```bash
# Set search engine to duckduckgo and depth to 3
python3 skills/swarm_config/configure.py --engine duckduckgo --depth 3

# Set operating mode to codebase audit
python3 skills/swarm_config/configure.py --mode audit

# Set divergence threshold (advisory; never gates a verdict)
python3 skills/swarm_config/configure.py --divergence 0.8
```

## 3. Configuration Schema (`.research/config.json`)

The active project configuration is persisted at `.research/config.json`:
```json
{
  "search_engine": "duckduckgo",
  "max_iterations": 2,
  "divergence_threshold": 0.75,
  "mode": "research",
  "backend": "auto",
  "cache_raw_markdown": true,
  "cache_ttl_days": null,
  "search_timeout_s": null,
  "searxng_url": null,
  "license_whitelist": ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC"],
  "output_dir": ".research"
}
```
All swarm agents read this file at initialization time.

The canonical contract (types, enums, ranges, defaults, per-key label / scope /
restart class / deprecated flag) lives in `runner/schemas.py` and is generated
into `schemas/config.schema.json`. `configure.py` builds `DEFAULT_CONFIG` from
that single source, so the two cannot drift.

Writes are single-writer safe: `save_config` takes the `.research/.config.lock`
advisory lock, validates against the canonical schema, preserves unknown keys
already on disk, and publishes via a unique temp file + `os.replace`. Pass
`expected_hash` (full SHA-256 or a unique prefix) to reject a stale write with a
fresh snapshot instead of clobbering a concurrent change. The MCP tool
`iumbtems_config` accepts every canonical key and applies the same validation
before writing.

Field notes (honest consumers — no key exists without one):

| Key | Consumer |
| --- | --- |
| `search_engine`, `max_iterations`, `mode`, `backend`, `allocation`, `domain_pack` | swarm dispatch |
| `agents.<role>.backend/model/opencode_agent` | agent argv resolution |
| `divergence_threshold` | **advisory only**: recorded in the run manifest + master synthesis *only when non-default*; never gates a verification decision |
| `license_whitelist` | darkharvest license policy (`cross_check_repos`); empty/missing falls back to the built-in permissive set |
| `cache_raw_markdown` | spawned children (`IUMBTEMS_CACHE_RAW_MARKDOWN`) honored by `webcache.py` |
| `cache_ttl_days` | spawned children (`IUMBTEMS_FETCH_TTL_DAYS`), already honored by `webcache.py` |
| `search_timeout_s` | search CLI default (`IUMBTEMS_SEARCH_TIMEOUT_S`) and the preflight probe |
| `searxng_url` | spawned children (`SEARXNG_URL`); preflight/provider resolution read the same env var |
| `verify.min_fuzzy_confidence` | `SourceHasher.verify_quote` parameter (default 0.88, clamped to [0, 1] there) used by audit runs and `iumbtems_verify_quote` |
| `output_dir` | **deprecated**: display-only; the workspace is chosen by `base_dir` / `--dir` |

Null semantics (enforced, not implied): `null` is accepted **only** for nullable
keys — `cache_ttl_days`, `search_timeout_s`, `searxng_url`, `domain_pack`,
`opencode_auto`, `opencode_agent`, and the per-role
`agents.<role>.backend/model/opencode_agent`. It means "clear / follow the
default policy" (for the env passthrough keys, the environment is left
untouched: webcache keeps its per-domain TTL policy, `search.py` keeps its 15s
default, the preflight probe keeps 5s). `null` for a non-nullable key is
rejected with the structured `NULL_FOR_NON_NULLABLE_KEY` error — it is never
silently masked as a no-op.

Value constraints: `searxng_url` must carry an `http://` or `https://` scheme;
`domain_pack` must be non-empty. Both are schema-level (`pattern` / `minLength`)
and enforced by `iumbtems_config` before any write. The write guard
`expected_hash` (alias `expectedHash`) requires a full SHA-256 or a unique
prefix of **at least 8 hex characters**; conflicting spellings are rejected with
`CONFLICTING_EXPECTED_HASH`. `heal_config` refuses to persist a file that fails
canonical validation (the legacy-pin migration stays in memory until the
invalid values are fixed). Non-healing reads (phase-08 R3 truth): no production
read path calls `heal_config` — `--show` / bare CLI, the MCP `show` leg, and
`load_config` itself never write. The migration is applied in memory on every
load and persists opportunistically when a later write leg merges the loaded
config; `heal_config` remains an exported, tested, explicit repair helper for
persisting the migration outside any other write.

## 4. TUI Settings Surface (OpenCode V2)

On OpenCode V2 hosts the plugin ships a native settings surface — the recommended
path when you are already inside OpenCode:

- **`/swarm-config` wizard** — `ui.dialog.select/prompt/confirm`, one row per
  canonical key with a provenance badge (`default` / `file` / `env-override`);
  edits validate on save.
- **`iumbtems.swarm-settings` status panel** — a read-only panel opened from the
  command palette / keymap showing the effective rows with a **next-run** badge;
  it never writes.

Both read and write the same canonical `.research/config.json`, preferring the
server `iumbtems.settings` RPC (server-side validation + `expectedHash` guard) and
degrading to a direct-fs write (`plugins/opencode/config-io.js`) with a visible
toast when `client.rpc` is absent. Live refresh subscribes to the RPC `changed`
event; the 5s poll remains the floor.

The honest boundaries are unchanged from the CLI/MCP paths: values apply to the
**next** swarm run (the runner reads config at run start); per-role temperature
does **not** govern spawned agents (dated `[NEGATIVE_KNOWLEDGE]`, waiver W3);
out-of-range `IUMBTEMS_TEMPERATURE[_<ROLE>]` values are DISCARDED (fail-closed),
not clamped; secrets stay in the environment. See `docs/SYSTEM_ARCHITECTURE.md`
§6.7 for the full data flow, the `.research/.config.lock` protocol, the
`expectedHash` guard, and the `ctx.storage` mirror.

## 5. Known limitations (recorded by phase 01)

- **Crash-safety scope (F9):** the atomic-write regression patches `os.replace`
  and proves the original file is untouched and the temp file is cleaned up on
  an in-process failure. A real `SIGKILL` between temp-write and rename can
  still leave a `config.json.*.tmp` file behind — that is inherent to the
  temp+rename protocol; the config itself is never torn.
- **Standalone fallback (F10):** when the `runner/` package is not importable,
  `configure.py` uses its self-contained atomic-write/lock fallbacks and skips
  canonical schema validation (fail-open by design) so the skill still runs.
  The canonical CLI/MCP surfaces always validate.
- **A2 environmental note:** in this sandbox a full
  `python3 -m unittest discover -s runner/tests` cannot go green —
  `test_search_provider.TestRunPathFailFast`/`TestMcpRunStatus` hang and
  `test_blocked_probe_halts_research` fails identically on pristine HEAD
  (pre-existing/environmental). The phase-owned suites
  (`test_config_schema`, `test_swarm_config`, `test_backends`,
  `test_darkharvest_audit`, `test_webcache`, `test_search_anomaly`, plus the
  touched `test_search_provider` cases) are the verification bar.


