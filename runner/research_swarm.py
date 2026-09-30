#!/usr/bin/env python3
"""
Epistemic Swarm: Dialectic Multi-Agent Research Runner.
Executes parallel Claude Code sub-processes (claude -p) for Proponent and Adversary agents,
monitors filesystem IPC scratchpads, and invokes the Epistemic Auditor.
Supports multiple modes: research, audit (codebase), scout (OSS), hybrid, brainstorm (lateral ideation), and darkharvest (product competitor teardown).
"""

import os
import sys
import json
import shutil
import argparse
import subprocess
from pathlib import Path
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, Any, List, Optional, Sequence, Tuple

# Ensure project root is in sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from runner.state_machine import (
    ResearchStateMachine,
    ScopeStatus,
    SessionStatus,
    _atomic_write_json,
)
from runner.auditor_engine import EpistemicAuditorEngine
from runner.errors import DossierNotFound
from runner.retrieval_log import current_offset as _retrieval_offset
from runner.retrieval_log import summarize as _retrieval_summary
from skills.research_cache.hasher import SourceHasher
from skills.swarm_config.configure import DEFAULT_CONFIG as _DEFAULT_CONFIG
from skills.swarm_config.configure import load_config

# Advisory divergence reference default (runner/schemas.py CONFIG_DEFAULTS).
# Emissions (manifest field, synthesis bullet, banner line) are gated on a
# NON-DEFAULT configured value so default runs stay byte-identical (R3).
_DEFAULT_DIVERGENCE_THRESHOLD = _DEFAULT_CONFIG["divergence_threshold"]

# Exit code for a fail-fast preflight refusal (search gate HALT). Deliberately
# distinct from argparse's usage-error code (2) so a script or CI can tell a
# deliberate refusal apart from a mistyped invocation. A dry run never halts: it
# validates configuration and reports (see `run_swarm`).
EXIT_PREFLIGHT_HALT = 3

EXAMPLE_RUST_RAFT_URL = "https://github.com/example/rust-raft"
# Common backends we can resolve without touching PATH. This is a convenience
# fast-path, NOT an allowlist: backend resolution is a documented extension
# point (CLI > IUMBTEMS_BACKEND_* > config), so any executable the OS can
# resolve must work. The security property is argv-list + shell=False, which
# run_claude_process already enforces; injection is not possible here.
KNOWN_BACKEND_BINARIES = {"claude", "opencode", "python", "python3", "node"}

# Host-native default backends (parity spec section 8). Claude Code spawns
# `claude -p`; OpenCode spawns `opencode run` (opencode.ai/docs/cli). The
# OpenCode plugin exports IUMBTEMS_HOST=opencode into every MCP dispatch so
# the default follows the host; explicit flags/env/config always win.
OPENCODE_RUN_BASE = ["opencode", "run"]

# Dossier filenames the loader and auditor require, per dialectic role.
ROLE_DOSSIER_FILENAMES = {"Alpha": "alpha_dossier.json", "Beta": "beta_dossier.json"}

# Additional filenames an agent may emit for a role in a given mode. Kept small
# and mode-scoped: a complete run must not die on a filename drift.
MODE_DOSSIER_ALIASES = {"brainstorm": ("brainstorm_dossier.json",)}

# Fenced JSON block marker shared by orchestrator/dossier stdout parsers.
_JSON_FENCE = "```json"


def _default_backend_cmd(config_host: Optional[str] = None) -> List[str]:
    """Host-native default backend argv.

    Precedence: explicit config_host ("claude"/"opencode") > IUMBTEMS_HOST env
    > binary probe (opencode when claude is absent) > legacy ["claude", "-p"].
    """
    host = (config_host or "").strip().lower()
    if host in ("", "auto"):
        host = os.environ.get("IUMBTEMS_HOST", "").strip().lower()
    if host == "opencode":
        return list(OPENCODE_RUN_BASE)
    if host == "claude":
        return ["claude", "-p"]
    if shutil.which("opencode") and not shutil.which("claude"):
        return list(OPENCODE_RUN_BASE)
    return ["claude", "-p"]


def _backend_family(backend: List[str]) -> str:
    return Path(backend[0]).name if backend else "claude"


def _agent_cwd(project_root: Path) -> str:
    """Working directory for spawned agent processes.

    The canonical agent prompts name evidence paths RELATIVELY (`.research/...`)
    and the runner reads dossiers from `<base_dir>/scratchpads/...`. Spawning in
    the package root made those writes land inside node_modules (denied). Spawn
    in the project root instead so `.research/` means the operator's evidence
    tree. Override with IUMBTEMS_AGENT_CWD=package|project|<absolute path>.
    """
    override = os.environ.get("IUMBTEMS_AGENT_CWD", "").strip()
    if override == "package":
        return str(PROJECT_ROOT)
    if override and override != "project":
        return override
    return str(project_root)


def _opencode_auto(config: Optional[Dict[str, Any]] = None) -> bool:
    """Whether to pass `--auto` to `opencode run`.

    `--auto` auto-approves permissions that are not explicitly denied. Without
    it, a spawned agent's write to the resolved `.research` path can be
    auto-rejected as `external_directory` when the child's workspace root differs
    from the runner's, silently dropping the dossier. Disable with
    `IUMBTEMS_OPENCODE_AUTO=0` or `.research/config.json` → `"opencode_auto": false`.
    """
    env = os.environ.get("IUMBTEMS_OPENCODE_AUTO", "").strip().lower()
    if env in ("0", "false", "no", "off"):
        return False
    if env in ("1", "true", "yes", "on"):
        return True
    val = (config or {}).get("opencode_auto")
    if val is not None:
        return bool(val)
    return True


def _advisory_number(value: Any, default: float) -> float:
    """Config number for advisory recording; malformed values keep the default."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return float(value)


def _verify_threshold(config: Optional[Dict[str, Any]]) -> float:
    """`verify.min_fuzzy_confidence` with the historical 0.88 default/clamp."""
    verify = (config or {}).get("verify")
    raw = verify.get("min_fuzzy_confidence") if isinstance(verify, dict) else None
    value = _advisory_number(raw, 0.88)
    return max(0.0, min(1.0, value))


def _config_child_env(
    base_dir: Path,
    agent_cwd: str,
    config: Optional[Dict[str, Any]],
    role: Optional[str] = None,
) -> Dict[str, str]:
    """Environment for a spawned agent child: base env + config passthrough.

    Follows the `IUMBTEMS_RESEARCH_DIR` precedent: config-sourced env overrides
    the inherited value, and null/default config keys are NOT exported (so
    absent defaults behave byte-identically to before these keys existed):

    * `cache_raw_markdown`      -> IUMBTEMS_CACHE_RAW_MARKDOWN=1/0 (webcache)
    * `cache_ttl_days`          -> IUMBTEMS_FETCH_TTL_DAYS (webcache, when set)
    * `search_timeout_s`        -> IUMBTEMS_SEARCH_TIMEOUT_S (search.py, when set)
    * `searxng_url`             -> SEARXNG_URL (search provider + searxng_mcp)
    * `role`                    -> IUMBTEMS_AGENT_ROLE (S3 temperature spike: lets
      a spawned `opencode run` child know its swarm role so the project
      plugin's `session.hook("context")` can key per-role temperature off
      `event.agent` — if the child loads the project plugin; absent/empty
      role exports nothing)
    """
    cfg = config or {}
    env: Dict[str, str] = {
        **os.environ,
        "PWD": agent_cwd,
        "IUMBTEMS_RESEARCH_DIR": str(base_dir),
        "IUMBTEMS_CACHE_RAW_MARKDOWN": (
            "0" if cfg.get("cache_raw_markdown") is False else "1"
        ),
    }
    ttl = cfg.get("cache_ttl_days")
    if isinstance(ttl, int) and not isinstance(ttl, bool) and ttl >= 0:
        env["IUMBTEMS_FETCH_TTL_DAYS"] = str(ttl)
    timeout = cfg.get("search_timeout_s")
    if (
        isinstance(timeout, (int, float))
        and not isinstance(timeout, bool)
        and timeout > 0
    ):
        env["IUMBTEMS_SEARCH_TIMEOUT_S"] = str(timeout)
    searxng = cfg.get("searxng_url")
    if isinstance(searxng, str) and searxng.strip():
        env["SEARXNG_URL"] = searxng.strip()
    if role:
        env["IUMBTEMS_AGENT_ROLE"] = str(role)
    return env


def _build_opencode_cmd(
    backend: List[str],
    prompt: str,
    model: Optional[str],
    agent: Optional[str],
    auto: bool = True,
) -> List[str]:
    """Argv for `opencode run` (docs: positional prompt, -m provider/model,
    --agent <name>, --format json, --auto). No --tools/--system-prompt flags."""
    cmd = list(backend) + [prompt]
    if agent:
        cmd.extend(["--agent", str(agent)])
    if model:
        cmd.extend(["-m", str(model)])
    cmd.extend(["--format", "json"])
    if auto:
        cmd.append("--auto")
    return cmd


_TEXT_EVENT_KEYS = ("text", "content", "message", "output", "result")
_TEXT_EVENT_MARKERS = ("message", "text", "result", "output", "content")


def _event_text(obj: Dict[str, Any]) -> Optional[str]:
    """Text payload of one parsed event line, or None.

    Handles the real `opencode run --format json` shape
    ({"type":"text", "part":{"type":"text","text":"..."}}) plus top-level
    variants for tolerance.
    """
    part = obj.get("part")
    if isinstance(part, dict):
        val = part.get("text")
        if isinstance(val, str) and val.strip():
            return val
    kind = str(obj.get("type", "")).lower()
    if kind and not any(m in kind for m in _TEXT_EVENT_MARKERS):
        return None
    for key in _TEXT_EVENT_KEYS:
        val = obj.get(key)
        if isinstance(val, str) and val.strip():
            return val
    return None


def _extract_opencode_text(raw: str) -> str:
    """Best-effort final text from `opencode run --format json` event stream.

    Tolerant by design: collects text fields from message/result/output style
    events and falls back to the raw stream when nothing parses, so unknown
    event shapes degrade to unparsed text rather than empty dossiers.
    """
    texts: List[str] = []
    for line in (raw or "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except (ValueError, TypeError):
            continue
        if isinstance(obj, dict):
            text = _event_text(obj)
            if text:
                texts.append(text)
    return "\n".join(texts).strip() if texts else (raw or "").strip()


def _validate_backend(backend: List[str]) -> List[str]:
    """Resolve-check a backend argv. Raises ValueError only if nothing can run it.

    Resolution mirrors what subprocess does with shell=False: an absolute/relative
    path is taken as-is (checked against the spawn cwd, PROJECT_ROOT), otherwise
    the name is looked up on PATH. Previously this rejected anything outside a
    five-name allowlist, which broke `python3.11`, `aider`, `codex exec`,
    `npx -y ...` and any config-supplied backend.
    """
    if not backend:
        return ["claude", "-p"]
    candidate = backend[0]
    bin_name = Path(candidate).name
    if bin_name in KNOWN_BACKEND_BINARIES:
        return list(backend)
    # Path form: resolve the same way the spawn will (cwd=PROJECT_ROOT).
    if os.sep in candidate or (os.altsep and os.altsep in candidate):
        resolved = (
            (PROJECT_ROOT / candidate).resolve()
            if not os.path.isabs(candidate)
            else Path(candidate)
        )
        if resolved.is_file():
            return list(backend)
        raise ValueError(
            f"Backend binary not found at {candidate!r} (resolved {resolved}); "
            f"expected an executable file relative to {PROJECT_ROOT}"
        )
    # Bare name: ask PATH, exactly as subprocess will.
    if shutil.which(candidate) is None:
        raise ValueError(
            f"Backend binary {candidate!r} is not on PATH and is not a known backend "
            f"({', '.join(sorted(KNOWN_BACKEND_BINARIES))})"
        )
    return list(backend)


def _first(*values):
    """First truthy value (keeps config-precedence chains flat for S3776)."""
    for v in values:
        if v:
            return v
    return None


class SwarmRunner:
    def __init__(
        self,
        base_dir: Optional[Path] = None,
        mock_mode: bool = False,
        mode: Optional[str] = None,
        engine: Optional[str] = None,
        depth: Optional[int] = None,
        agent_overrides: Optional[Dict[str, Dict[str, Any]]] = None,
        allocation: Optional[str] = None,
        domain_pack: Optional[str] = None,
        resume: bool = False,
        dry_run: bool = False,
    ):
        self.base_dir = base_dir or Path(".research")
        self.resume = resume
        self.dry_run = dry_run
        # Set by run_swarm: the mode-aware search gate verdict and whether a
        # fail-fast halt refused the run (the CLI maps that to a non-zero exit).
        self._search_gate: Optional[Dict[str, Any]] = None
        self._halted = False
        # Project root = the directory containing the evidence dir. Agents are
        # spawned here so the relative `.research/...` paths named by the
        # canonical prompts resolve to the RUNNER's evidence tree. Spawning in
        # PROJECT_ROOT (the installed package) sent those writes into
        # node_modules, where they were denied and no agent-authored dossier
        # ever landed — runs survived only on the stdout-recovery fallback.
        self.project_root = Path(os.path.realpath(str(self.base_dir))).parent
        self.mock_mode = mock_mode
        self.config = load_config(str(self.base_dir))
        cfg = self.config
        self.mode = _first(mode, cfg.get("mode"), "research")
        self.engine = _first(engine, cfg.get("search_engine"), "duckduckgo")
        self.depth = _first(depth, cfg.get("max_iterations"), 2)
        # Advisory divergence reference: recorded (manifest + summary) only when
        # configured to a non-default value; it never gates a verdict. Default
        # runs emit nothing here (byte-identical-defaults rule, R3).
        self.divergence_threshold = _advisory_number(
            cfg.get("divergence_threshold"), _DEFAULT_DIVERGENCE_THRESHOLD
        )
        self.divergence_threshold_configured = (
            self.divergence_threshold != _DEFAULT_DIVERGENCE_THRESHOLD
        )
        # Stream F: "dag" (legacy default) or "auction" (Frontier Markets).
        self.allocation = _first(allocation, cfg.get("allocation"), "dag")
        # Stream G: optional Domain Pack (constitution) for the auditor.
        self.domain_pack = (
            domain_pack if domain_pack is not None else cfg.get("domain_pack")
        )
        # Per-agent backend/model overrides (CLI > env > config > default).
        # Keys are role names ("alpha", "beta"); values are {"backend": [...],
        # "model": str|None}. Empty dict means "fall through to next source".
        self.agent_overrides: Dict[str, Dict[str, Any]] = agent_overrides or {}
        self.state_machine = ResearchStateMachine(
            base_dir=self.base_dir, mode=self.mode
        )
        from runner.auditor_engine import _repo_validation_enabled
        from runner.darkharvest_claims import RepoValidator

        self.auditor = EpistemicAuditorEngine(
            base_dir=self.base_dir,
            # Ground-truth repo checks are for real runs; mock dossiers are
            # synthetic, so the unit suite must stay offline.
            repo_validator=RepoValidator(
                enabled=(not self.mock_mode) and _repo_validation_enabled()
            ),
            # Config wiring: default-absent values reproduce the historical
            # 0.88 fuzzy threshold and built-in license whitelist exactly.
            min_fuzzy_confidence=_verify_threshold(cfg),
            license_whitelist=cfg.get("license_whitelist"),
        )
        self.hasher = SourceHasher(base_dir=self.base_dir)
        self.prompts_dir = PROJECT_ROOT / "prompts"

    def _resolve_agent_backend(self, role: str) -> Tuple[List[str], Optional[str]]:
        """Resolve (backend_cmd, model) for an agent role.

        Precedence: explicit override (set by CLI flags) > env >
        config > host-native default. Returns the legacy ["claude", "-p"]
        only when nothing else selects opencode, preserving prior behavior
        byte-for-byte on Claude Code hosts.
        """
        override = self.agent_overrides.get(role) or {}
        env_backend = os.environ.get(f"IUMBTEMS_BACKEND_{role.upper()}")
        env_model = os.environ.get(f"IUMBTEMS_MODEL_{role.upper()}")

        agents_cfg = self.config.get("agents") or {}
        role_cfg = agents_cfg.get(role) or {}

        backend = (
            override.get("backend")
            or (env_backend.split() if env_backend else None)
            or role_cfg.get("backend")
            or _default_backend_cmd(self.config.get("backend"))
        )
        model = override.get("model") or env_model or role_cfg.get("model")
        self._warn_backend_host_mismatch(role, backend)
        return list(backend), model

    @staticmethod
    def _warn_backend_host_mismatch(role: str, backend: List[str]) -> None:
        """Surface a config pin that silently defeats the host-native default.

        Observed live: a pre-0.7.6 config pin of ["claude", "-p"] beat
        IUMBTEMS_HOST=opencode, so an OpenCode host spawned Claude with no
        signal. Warn loudly instead of failing silently.
        """
        host = os.environ.get("IUMBTEMS_HOST", "").strip().lower()
        if host not in ("claude", "opencode"):
            return
        family = _backend_family(backend)
        if family == host:
            return
        sys.stderr.write(
            f"[swarm] WARNING: role={role} resolved backend={family!r} from an "
            f"explicit pin/override, but IUMBTEMS_HOST={host!r}. The explicit pin "
            f"wins. Set backend: {host!r}, agents.{role}.backend: null, or "
            f"IUMBTEMS_BACKEND_{role.upper()}={host} to follow the host.\n"
        )

    def _scope_prompt(self, role: str, scope: Dict[str, Any], scope_id: str) -> str:
        """Prompt for a dialectic agent, naming its exact output contract.

        The canonical prompts describe evidence paths RELATIVELY, so a bare scope
        id left the agent guessing which `.research` tree to write to — and, in
        brainstorm mode, which dossier filename to emit. Name the absolute
        scratchpad dir AND the role's dossier file, and forbid writing the
        runner-owned manifest.
        """
        scope_dir = self.state_machine.get_scope_dir(scope_id)
        dossier = ROLE_DOSSIER_FILENAMES.get(role, f"{role.lower()}_dossier.json")
        return (
            f"Run Agent {role} ({self.mode} mode) for scope: {json.dumps(scope)}. "
            f"Engine: {self.engine}. Depth: {self.depth}. "
            f"Write your role dossier to {scope_dir / dossier} (scope {scope_id}) "
            f"and no other dossier file. Do NOT create or modify manifest.json in "
            f"{scope_dir} — it is runner-owned."
        )

    def _resolve_opencode_agent(self, role: str) -> Optional[str]:
        """Explicitly configured OpenCode agent for this role, else None.

        Default is None: the system prompt is inlined into the message because
        `--agent <name>` fails hard ("Agent not found") unless the user
        installed the snippet agent profiles — observed live, so the backend
        must not depend on them. Set `agents.<role>.opencode_agent` (or the
        top-level `opencode_agent` config key) to opt in.
        """
        role_cfg = (self.config.get("agents") or {}).get(role) or {}
        return role_cfg.get("opencode_agent") or self.config.get("opencode_agent")

    def build_agent_cmd(
        self,
        prompt: str,
        system_prompt_file: Optional[Path] = None,
        tools: str = "default",
        role: str = "alpha",
    ) -> List[str]:
        """Construct the backend argv for an agent. Pure — no subprocess.

        Exposed separately so tests can assert argv shape (e.g. `--model`
        present when configured, absent in mock/default) without spawning.
        Claude keeps the legacy shape; opencode builds `opencode run` argv.
        """
        backend, model = self._resolve_agent_backend(role)
        # S8701 residual: argv-list + shell=False already blocks shell
        # injection, but a prompt beginning with "-" would be parsed as a
        # CLI flag by the backend. Agent prompts are generated text and never
        # legitimately start with a dash.
        if prompt.startswith("-"):
            raise ValueError(
                "Refusing to pass a prompt starting with '-' to the agent "
                "backend (CLI flag injection)"
            )
        if _backend_family(backend) == "opencode":
            agent = self._resolve_opencode_agent(role)
            # No --system-prompt flag exists on `opencode run`, and --agent
            # only works when the user installed the profile. Inline the
            # system prompt into the message so runs never depend on
            # host-side agent configuration.
            if system_prompt_file and system_prompt_file.exists():
                prompt = (
                    system_prompt_file.read_text(encoding="utf-8") + "\n\n" + prompt
                )
            return _build_opencode_cmd(
                backend, prompt, model, agent, auto=_opencode_auto(self.config)
            )
        cmd = list(backend) + [prompt, "--tools", tools]
        if model:
            cmd.extend(["--model", str(model)])
        if system_prompt_file and system_prompt_file.exists():
            cmd.extend(["--system-prompt", str(system_prompt_file)])
        return cmd

    def run_claude_process(
        self,
        prompt: str,
        system_prompt_file: Optional[Path] = None,
        tools: str = "default",
        role: str = "alpha",
    ) -> str:
        """Executes a headless agent session on the configured backend."""
        if self.mock_mode:
            return self._mock_claude_response(prompt)

        cmd = self.build_agent_cmd(prompt, system_prompt_file, tools, role=role)
        family = _backend_family(cmd)

        try:
            if cmd:
                _validate_backend([cmd[0]])
            agent_cwd = _agent_cwd(self.project_root)
            res = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=True,
                cwd=agent_cwd,
                # `opencode run` resolves its project root from $PWD, not the OS
                # cwd — and subprocess.run(cwd=...) does NOT update PWD. Without
                # this the worker operated on the launcher's PWD (observed live:
                # runner evidence dir 5da7ec/sunny-otter, worker cwd
                # /home/john/Projects/STC). Keep PWD consistent with cwd.
                # IUMBTEMS_RESEARCH_DIR points agent-invoked skill scripts
                # (search.py/hasher.py) at this workspace for retrieval telemetry;
                # the cache/search keys ride the same env channel.
                env=_config_child_env(self.base_dir, agent_cwd, self.config, role),
                # stdin MUST be DEVNULL: `opencode run` reads piped stdin to
                # EOF before starting, and the MCP server's inherited stdin
                # pipe is held open by the harness — every agent hung forever
                # (observed live: 10+ min, 1s CPU, no network I/O).
                stdin=subprocess.DEVNULL,
                shell=False,
            )
            if family == "opencode":
                return _extract_opencode_text(res.stdout)
            return res.stdout.strip()
        except subprocess.CalledProcessError as e:
            stderr = e.stderr or ""
            hint = self._permission_failure_hint(stderr)
            print(
                f"[ERROR] {family} backend process failed: {stderr}{hint}",
                file=sys.stderr,
            )
            raise RuntimeError(f"{family} backend execution failed: {stderr}{hint}")
        except ValueError as e:
            # Bad backend config: report it as a run failure, not an abort of the
            # whole swarm. Matches the pre-allowlist behavior of surfacing the
            # error from inside the try.
            print(f"[ERROR] Invalid agent backend: {e}", file=sys.stderr)
            raise RuntimeError(f"Invalid agent backend: {e}")

    def _permission_failure_hint(self, stderr: str) -> str:
        """Actionable hint when the backend refused a write as external.

        Reproduced failure shape: `! permission requested: external_directory
        (<worktree>/.research/...) ; auto-rejecting` — the child's workspace root
        disagreed with the runner's, so the dossier write was denied.
        """
        lowered = (stderr or "").lower()
        if (
            "external_directory" not in lowered
            and "permission requested" not in lowered
        ):
            return ""
        return (
            "\n[hint] The spawned backend treated the workspace as external and "
            "auto-rejected the write. Ensure its workspace matches the runner's "
            f"({self.base_dir}). For OpenCode the backend is spawned with "
            "cwd and PWD set to the project root and `--auto` "
            "(disable with IUMBTEMS_OPENCODE_AUTO=0)."
        )

    def _mock_claude_response(self, prompt: str) -> str:
        """Mock response generator for unit testing without live API keys."""
        if "Orchestrator" in prompt or "manifest.json" in prompt:
            return json.dumps(
                {
                    "session_id": "mock-session-001",
                    "objective": "Evaluate ZK prover latency",
                    "scopes": [
                        {
                            "scope_id": "scope_01_latency",
                            "title": "Hardware Prover Latency Bounds",
                            "objective": "Evaluate Poseidon hash witness generation latency on FPGAs vs GPUs",
                            "dependencies": [],
                            "affirmative_targets": [
                                "Sub-200ms witness generation on 2^20 constraints"
                            ],
                            "adversarial_targets": [
                                "PCIe bus bottlenecks during batch streaming"
                            ],
                        }
                    ],
                }
            )
        return "MOCK_RESPONSE"

    def orchestrate_objective(
        self, objective: str, frontier_file: Optional[Path] = None
    ) -> List[Dict[str, Any]]:
        """Phase 1: Run Swarm Orchestrator to decompose the research/audit question."""
        print(
            f"\n🧠 [Phase 1: Orchestration] Decomposing objective ({self.mode.upper()} mode): '{objective}'..."
        )
        self.state_machine.init_session(objective)
        self.state_machine.update_session_status(SessionStatus.ORCHESTRATING)

        frontier_context = ""
        if frontier_file and frontier_file.exists():
            with open(frontier_file, "r", encoding="utf-8") as f:
                frontier_data = json.load(f)
                frontier_context = f"\nSETTLED CONSTRAINTS FROM FRONTIER:\n{json.dumps(frontier_data.get('settled_constraints', {}), indent=2)}"

        orchestrator_prompt = f"""
You are the Swarm Orchestrator operating in {self.mode.upper()} mode. Read prompts/orchestrator.md.
Objective: {objective}
Engine: {self.engine}
Max Depth: {self.depth}
{frontier_context}

Output ONLY valid JSON representing the scope decomposition conforming to prompts/orchestrator.md.
"""
        system_prompt = self.prompts_dir / "orchestrator.md"
        raw_output = self.run_claude_process(
            orchestrator_prompt, system_prompt_file=system_prompt
        )

        # Parse JSON (fence-aware; falls back to a single-scope decomposition)
        manifest_data = self._parse_json_block(raw_output, require_key="scopes")
        if manifest_data is not None:
            scopes = manifest_data.get("scopes", [])
        else:
            print(
                "[WARN] Failed to parse JSON from orchestrator output. "
                "Using fallback decomposition."
            )
            scopes = [
                {
                    "scope_id": "scope_01_primary_investigation",
                    "title": f"Investigation: {objective[:40]}",
                    "objective": objective,
                    "dependencies": [],
                    "affirmative_targets": ["Find corroborating empirical data"],
                    "adversarial_targets": [
                        "Probe counter-arguments and failure modes"
                    ],
                }
            ]

        self.state_machine.set_scopes(scopes)
        print(f"✅ Generated {len(scopes)} decoupled dialectic scopes.")
        return scopes

    @staticmethod
    def _parse_json_block(
        text: str, require_key: str = "scope_id"
    ) -> Optional[Dict[str, Any]]:
        """Extract a JSON object from free-form agent stdout (fence-aware)."""
        if not text or not text.strip():
            return None
        candidates = [text]
        if _JSON_FENCE in text:
            candidates.append(text.split(_JSON_FENCE, 1)[1].split("```")[0])
        elif "```" in text:
            candidates.append(text.split("```", 1)[1].split("```")[0])
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            candidates.append(text[start : end + 1])
        for candidate in candidates:
            try:
                obj = json.loads(candidate.strip())
            except (ValueError, TypeError):
                continue
            if isinstance(obj, dict) and obj.get(require_key):
                return obj
        return None

    @staticmethod
    def _parse_dossier_json(text: str) -> Optional[Dict[str, Any]]:
        """Extract a dossier dict from free-form agent stdout (fence-aware)."""
        return SwarmRunner._parse_json_block(text, require_key="scope_id")

    @staticmethod
    def _warn_schema_violations(dossier: Dict[str, Any], role: str) -> None:
        """Advisory contract check — warn with the offending key, never abort (#6 2.1)."""
        try:
            from runner.schema_validate import check_dossier

            problems = check_dossier(dossier, role)
        except Exception:  # noqa: BLE001 - validation must never break a run
            return
        for problem in problems[:5]:
            sys.stderr.write(f"[swarm] schema: {problem}\n")
        if len(problems) > 5:
            sys.stderr.write(
                f"[swarm] schema: … {len(problems) - 5} more violation(s)\n"
            )

    @staticmethod
    def _load_dossier_file(
        path: Path, expected_scope: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """Load a path as a dossier dict for `expected_scope`, or None.

        A file under the research dir is untrusted input: require a `scope_id`
        that matches the scope being loaded, so a stray or stub artifact cannot
        satisfy completion for a different scope.
        """
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return None
        if not isinstance(data, dict):
            return None
        scope_id = data.get("scope_id")
        if not scope_id:
            return None
        if expected_scope is not None and scope_id != expected_scope:
            return None
        return data

    def _dossier_candidates(
        self, dossier_path: Path, aliases: Sequence[str]
    ) -> List[Path]:
        """Candidate dossier paths: canonical, mode aliases, then manifest outputs.

        Agents in some modes emit a differently named artifact (brainstorm writes
        `brainstorm_dossier.json`), and the scope manifest may record an `outputs`
        list. Accepting those keeps a complete run from dying on a filename drift.
        """
        scope_dir = dossier_path.parent
        candidates = [dossier_path]
        candidates.extend(scope_dir / alias for alias in aliases)
        manifest_p = scope_dir / "manifest.json"
        if manifest_p.exists():
            try:
                outputs = (
                    json.loads(manifest_p.read_text(encoding="utf-8")).get("outputs")
                    or []
                )
            except (OSError, ValueError):
                outputs = []
            for name in outputs:
                if isinstance(name, str) and name.endswith(".json"):
                    candidate = scope_dir / Path(name).name
                    if candidate.name not in ("manifest.json", "domain_model.json"):
                        candidates.append(candidate)
        seen: set = set()
        unique: List[Path] = []
        for candidate in candidates:
            if candidate not in seen:
                seen.add(candidate)
                unique.append(candidate)
        return unique

    def _load_agent_dossier(
        self,
        dossier_path: Path,
        scope_id: str,
        role: str,
        transcript: Optional[str] = None,
        aliases: Sequence[str] = (),
    ) -> Dict[str, Any]:
        """Load an agent dossier from disk, tolerating mode-specific filenames.

        Tries the canonical path, then mode aliases, then the scope manifest's
        `outputs`. A hit under an alias is normalized to the canonical filename so
        the auditor and claim index stay consistent. Falls back to parsing the
        agent's stdout, then raises a diagnostic error naming where it looked.
        """
        for candidate in self._dossier_candidates(dossier_path, aliases):
            data = self._load_dossier_file(candidate, scope_id)
            if data is None:
                continue
            if candidate != dossier_path:
                data.setdefault("renamed_from", candidate.name)
                dossier_path.parent.mkdir(parents=True, exist_ok=True)
                _atomic_write_json(dossier_path, data)
                print(
                    f"  [{role}] ⚠️ Dossier found as {candidate.name}; "
                    f"normalized to {dossier_path.name}."
                )
            self._warn_schema_violations(data, role)
            return data
        recovered = self._parse_dossier_json(transcript or "")
        if recovered is not None:
            recovered.setdefault("recovered_from_stdout", True)
            dossier_path.parent.mkdir(parents=True, exist_ok=True)
            _atomic_write_json(dossier_path, recovered)
            print(f"  [{role}] ⚠️ Dossier file missing; recovered from stdout.")
            return recovered
        message = self._dossier_missing_message(dossier_path, scope_id, role, aliases)
        elsewhere = None
        for name in [dossier_path.name, *aliases]:
            found = self._locate_dossier_elsewhere(scope_id, name)
            if found:
                elsewhere = found
                break
        raise DossierNotFound(
            code="DOSSIER_NOT_FOUND",
            message=message,
            path_searched=str(dossier_path),
            path_written=str(elsewhere) if elsewhere else None,
            workspace=str(self.base_dir),
            spawn_cwd=_agent_cwd(self.project_root),
            suggested_fix=(
                "The agent likely wrote to a different workspace than the runner "
                "reads. Re-run on the current plugin, or point IUMBTEMS_AGENT_CWD / "
                "IUMBTEMS_PROJECT_DIR at the runner's workspace."
            ),
        )

    def _dossier_missing_message(
        self, dossier_path: Path, scope_id: str, role: str, aliases: Sequence[str] = ()
    ) -> str:
        """Diagnostic message naming the searched path and any stray copy.

        The recurring failure mode is a workspace mismatch: the agent writes the
        dossier to a different `.research` tree than the runner reads. Reporting
        only the searched path made that invisible, so scan the plausible
        alternates — scoped to THIS scope id — and say where the dossier is.
        """
        lines = [
            f"{role} dossier not found at {dossier_path} and no dossier JSON "
            f"in transcript for scope {scope_id}",
            f"  runner workspace : {self.base_dir}",
            f"  spawn cwd/PWD    : {_agent_cwd(self.project_root)}",
            f"  IUMBTEMS_PROJECT_DIR: {os.environ.get('IUMBTEMS_PROJECT_DIR', '(unset)')}",
        ]
        names = [dossier_path.name, *aliases]
        found = None
        for name in names:
            found = self._locate_dossier_elsewhere(scope_id, name)
            if found:
                break
        if found:
            lines.append(
                f"  FOUND A COPY ELSEWHERE: {found} — the spawned agent wrote "
                f"to a different workspace than the runner reads"
            )
        else:
            lines.append(
                "  no copy found in alternate workspaces (PWD / git common dir parent)"
            )
        return "\n".join(lines)

    def _locate_dossier_elsewhere(self, scope_id: str, filename: str) -> Optional[Path]:
        """Find this scope's dossier in a workspace the agent might have used.

        Scoped to `<root>/.research/scratchpads/<scope_id>/` so an unrelated older
        scope holding a same-named file is never reported as a match.
        """
        roots: List[Path] = []
        pwd = os.environ.get("PWD", "").strip()
        if pwd:
            roots.append(Path(pwd))
        env_project = os.environ.get("IUMBTEMS_PROJECT_DIR", "").strip()
        if env_project:
            roots.append(Path(env_project))
        # Parent of the git common dir = the primary clone for a linked worktree.
        try:
            out = subprocess.run(
                ["git", "rev-parse", "--git-common-dir"],
                cwd=str(self.project_root),
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            if out.returncode == 0 and out.stdout.strip():
                common = Path(out.stdout.strip())
                if not common.is_absolute():
                    common = self.project_root / common
                roots.append(common.resolve().parent)
        except (OSError, subprocess.SubprocessError):
            pass
        for root in roots:
            candidate = root / ".research" / "scratchpads" / scope_id / filename
            if candidate.exists():
                return candidate
        return None

    def run_agent_alpha(self, scope: Dict[str, Any]):
        """Executes Agent Alpha (Thesis / Proponent / Structural Auditor) for a scope."""
        scope_id = scope["scope_id"]
        print(
            f"  [Alpha] 🏛️ Starting Agent Alpha ({self.mode.upper()} Thesis) on [{scope_id}]..."
        )

        if self.mock_mode:
            if self.mode == "audit":
                sample_content = "# System State Machine Architecture\nAtomic state transitions enforce ACID consistency via write-then-rename."
                shash = self.hasher.store_source(
                    "file:///runner/state_machine.py", sample_content, "State Machine"
                )
                dossier = {
                    "agent": "Agent Alpha (Code Architect)",
                    "mode": "code_audit",
                    "scope_id": scope_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "affirmative_claims": [
                        {
                            "claim_id": "ALPHA-A01",
                            "tag": "VERIFIED",
                            "statement": "State machine transitions enforce atomic ACID guarantees across scratchpad files.",
                            "source_hash": shash,
                            "source_url": "file:///runner/state_machine.py#L45-L65",
                            "verbatim_quote": "Atomic state transitions enforce ACID consistency via write-then-rename.",
                        }
                    ],
                    "inferred_implications": [],
                    "negative_knowledge": [],
                }
            elif self.mode == "scout":
                sample_content = "# High Performance Raft in Rust\nZero-dependency Raft implementation with 150k ops/sec throughput under Apache-2.0."
                shash = self.hasher.store_source(
                    EXAMPLE_RUST_RAFT_URL, sample_content, "Rust Raft"
                )
                dossier = {
                    "agent": "Agent Alpha (OSS Scout)",
                    "mode": "oss_scout",
                    "scope_id": scope_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "affirmative_claims": [
                        {
                            "claim_id": "ALPHA-S01",
                            "tag": "VERIFIED",
                            "statement": "Rust-Raft achieves 150k ops/sec with zero external dependencies.",
                            "source_hash": shash,
                            "source_url": EXAMPLE_RUST_RAFT_URL,
                            "verbatim_quote": "Zero-dependency Raft implementation with 150k ops/sec throughput under Apache-2.0.",
                        }
                    ],
                    "inferred_implications": [],
                    "negative_knowledge": [],
                }
            elif self.mode == "brainstorm":
                sample_content = "# Workspace Domain Snapshot\nEntities: swarm runner, dialectic dossiers, content-addressed cache. Constraint: evidence primacy."
                shash = self.hasher.store_source(
                    "file:///.research/domain_model.json",
                    sample_content,
                    "Domain Snapshot",
                )
                dossier = {
                    "agent": "Agent Alpha (Wild Proponent)",
                    "mode": "brainstorm",
                    "scope_id": scope_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "affirmative_claims": [
                        {
                            "claim_id": "ALPHA-B01",
                            "tag": "VERIFIED",
                            "statement": "Workspace entities center on swarm runner, dialectic dossiers, and content-addressed cache.",
                            "source_hash": shash,
                            "source_url": "file:///.research/domain_model.json",
                            "verbatim_quote": "Entities: swarm runner, dialectic dossiers, content-addressed cache.",
                        }
                    ],
                    "inferred_implications": [
                        {
                            "inference_id": "ALPHA-BI01",
                            "tag": "HYPOTHESIS",
                            "statement": "What-if: divergence-rewarded synthesis produces higher-upside feature vectors than evidence-gated synthesis.",
                            "parent_claims": ["ALPHA-B01"],
                            "deductive_logic": "Falsified if blind A/B of brainstorm vs research briefs shows no novelty gain per reviewer vote.",
                            "falsification": "Blind reviewer novelty vote shows no gain within 2 review rounds.",
                        }
                    ],
                    "negative_knowledge": [],
                }
            elif self.mode == "darkharvest":
                sample_content = "# Competitor Teardown Snapshot\nCapability: session handoff across agent harnesses. Verdict: clean-room-rebuild under Apache-2.0."
                shash = self.hasher.store_source(
                    "https://github.com/example/agent-harness",
                    sample_content,
                    "Competitor Snapshot",
                )
                dossier = {
                    "agent": "Agent Alpha (Harvest Proponent)",
                    "mode": "darkharvest",
                    "scope_id": scope_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "affirmative_claims": [
                        {
                            "claim_id": "ALPHA-D01",
                            "tag": "VERIFIED",
                            "statement": "Competitor ships session handoff with portable workspace state.",
                            "source_hash": shash,
                            "source_url": "https://github.com/example/agent-harness",
                            "verbatim_quote": "Capability: session handoff across agent harnesses.",
                        }
                    ],
                    "inferred_implications": [],
                    "negative_knowledge": [],
                }
            else:
                sample_content = "# FPGA Prover Benchmark\nOur FPGA pipeline executes the Poseidon round constraints in 184ms with a peak memory bandwidth of 45 GB/s."
                shash = self.hasher.store_source(
                    "https://arxiv.org/abs/2405.0001", sample_content, "FPGA Benchmark"
                )
                dossier = {
                    "agent": "Agent Alpha (Thesis)",
                    "scope_id": scope_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "affirmative_claims": [
                        {
                            "claim_id": "ALPHA-C01",
                            "tag": "VERIFIED",
                            "statement": "FPGA-accelerated Poseidon provers achieve sub-200ms latency on 2^20 constraints.",
                            "source_hash": shash,
                            "source_url": "https://arxiv.org/abs/2405.0001",
                            "verbatim_quote": "Our FPGA pipeline executes the Poseidon round constraints in 184ms with a peak memory bandwidth of 45 GB/s.",
                        }
                    ],
                    "inferred_implications": [
                        {
                            "inference_id": "ALPHA-I01",
                            "tag": "INFERRED",
                            "statement": "Hardware provers satisfy 1-second block finality bounds.",
                            "parent_claims": ["ALPHA-C01"],
                            "deductive_logic": "184ms << 1000ms target.",
                        }
                    ],
                    "negative_knowledge": [],
                }
        else:
            prompt = self._scope_prompt("Alpha", scope, scope_id)
            if self.mode == "audit":
                system_prompt = self.prompts_dir / "agent_code_auditor.md"
            elif self.mode == "scout":
                system_prompt = self.prompts_dir / "agent_oss_scout.md"
            elif self.mode == "brainstorm":
                system_prompt = self.prompts_dir / "agent_brainstormer.md"
            elif self.mode == "darkharvest":
                system_prompt = self.prompts_dir / "agent_darkharvest.md"
            else:
                system_prompt = self.prompts_dir / "agent_alpha_thesis.md"
            transcript = self.run_claude_process(
                prompt, system_prompt_file=system_prompt, role="alpha"
            )
            dossier_path = (
                self.state_machine.get_scope_dir(scope_id) / "alpha_dossier.json"
            )
            dossier = self._load_agent_dossier(
                dossier_path,
                scope_id,
                "alpha",
                transcript,
                aliases=MODE_DOSSIER_ALIASES.get(self.mode, ()),
            )

        self.state_machine.record_agent_completion(scope_id, "alpha", dossier)
        print(f"  [Alpha] ✅ Completed Agent Alpha for [{scope_id}].")

    def run_agent_beta(self, scope: Dict[str, Any]):
        """Executes Agent Beta (Antithesis / Red Team) for a scope."""
        scope_id = scope["scope_id"]
        print(
            f"  [Beta] 🎯 Starting Agent Beta ({self.mode.upper()} Red Team) on [{scope_id}]..."
        )

        if self.mock_mode:
            if self.mode == "audit":
                sample_content = "# Concurrency Analysis\nSubprocess writes may conflict if file descriptors are left open across parallel threads."
                shash = self.hasher.store_source(
                    "file:///runner/state_machine.py#race",
                    sample_content,
                    "Concurrency Check",
                )
                dossier = {
                    "agent": "Agent Beta (Code Red Team)",
                    "mode": "code_audit",
                    "scope_id": scope_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "falsification_claims": [
                        {
                            "claim_id": "BETA-A01",
                            "tag": "VERIFIED",
                            "statement": "Subprocess writes may conflict if file descriptors are left open across parallel threads.",
                            "source_hash": shash,
                            "source_url": "file:///runner/state_machine.py#race",
                            "verbatim_quote": "Subprocess writes may conflict if file descriptors are left open across parallel threads.",
                            "severity": "MEDIUM",
                        }
                    ],
                    "methodological_critiques": [
                        {
                            "target_assertion": "State machine transitions enforce atomic ACID guarantees across scratchpad files.",
                            "critique": "Unprotected open(..., 'w') creates race condition window between concurrent agents.",
                            "evidence_hash": shash,
                        }
                    ],
                    "negative_knowledge": [],
                }
            elif self.mode == "scout":
                sample_content = "# High Performance Raft in Rust\nZero-dependency Raft implementation with 150k ops/sec throughput under Apache-2.0."
                shash = self.hasher.store_source(
                    EXAMPLE_RUST_RAFT_URL, sample_content, "Rust Raft"
                )
                dossier = {
                    "agent": "Agent Beta (OSS Red Team)",
                    "mode": "oss_scout",
                    "scope_id": scope_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "falsification_claims": [
                        {
                            "claim_id": "BETA-S01",
                            "tag": "VERIFIED",
                            "statement": "Candidate repository has single maintainer with 9-month lull in commit history.",
                            "source_hash": shash,
                            "source_url": EXAMPLE_RUST_RAFT_URL,
                            "verbatim_quote": "Zero-dependency Raft implementation with 150k ops/sec throughput under Apache-2.0.",
                            "severity": "LOW",
                        }
                    ],
                    "methodological_critiques": [
                        {
                            "target_assertion": "Rust-Raft achieves 150k ops/sec with zero external dependencies.",
                            "critique": "Throughput degrades during log compaction due to unbuffered disk sync.",
                            "evidence_hash": shash,
                        }
                    ],
                    "negative_knowledge": [],
                }
            elif self.mode == "brainstorm":
                sample_content = "# Inversion Probe\nWhat if the evidence gate is the bottleneck? Divergence-rewarded synthesis explores what-if mechanics first."
                shash = self.hasher.store_source(
                    "file:///.research/domain_model.json#inversion",
                    sample_content,
                    "Inversion Probe",
                )
                dossier = {
                    "agent": "Agent Beta (Radical Inverter)",
                    "mode": "brainstorm",
                    "scope_id": scope_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "falsification_claims": [
                        {
                            "claim_id": "BETA-B01",
                            "tag": "VERIFIED",
                            "statement": "Inversion probe: evidence gating may bottleneck lateral ideation throughput.",
                            "source_hash": shash,
                            "source_url": "file:///.research/domain_model.json#inversion",
                            "verbatim_quote": "What if the evidence gate is the bottleneck?",
                            "severity": "INFO",
                        }
                    ],
                    "methodological_critiques": [
                        {
                            "target_assertion": "Divergence-rewarded synthesis produces higher-upside feature vectors.",
                            "critique": "Novelty without falsification probes is indistinguishable from hallucination; require spike tests.",
                            "evidence_hash": shash,
                        }
                    ],
                    "negative_knowledge": [],
                }
            elif self.mode == "darkharvest":
                sample_content = "# Competitor Risk Note\nSingle-maintainer harness with AGPL-licensed session sync; porting effort M."
                shash = self.hasher.store_source(
                    "https://github.com/example/agent-harness#risks",
                    sample_content,
                    "Competitor Risks",
                )
                dossier = {
                    "agent": "Agent Beta (Harvest Red Team)",
                    "mode": "darkharvest",
                    "scope_id": scope_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "falsification_claims": [
                        {
                            "claim_id": "BETA-D01",
                            "tag": "VERIFIED",
                            "statement": "Competitor session sync is AGPL-licensed and single-maintained.",
                            "source_hash": shash,
                            "source_url": "https://github.com/example/agent-harness#risks",
                            "verbatim_quote": "Single-maintainer harness with AGPL-licensed session sync",
                            "severity": "HIGH",
                        }
                    ],
                    "methodological_critiques": [
                        {
                            "target_assertion": "Competitor session handoff is safe to vendor.",
                            "critique": "AGPL copyleft requires clean-room rebuild; vendor only permissive parts with SPDX attribution.",
                            "evidence_hash": shash,
                        }
                    ],
                    "negative_knowledge": [],
                }
            else:
                sample_content = "# PCIe Bus Saturation Study\nIn continuous batch streaming, PCIe 4.0 transfers introduce a 650ms delay, yielding total latency > 800ms."
                shash = self.hasher.store_source(
                    "https://arxiv.org/abs/2406.9999",
                    sample_content,
                    "PCIe Bottlenecks",
                )

                dossier = {
                    "agent": "Agent Beta (Red Team)",
                    "scope_id": scope_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "falsification_claims": [
                        {
                            "claim_id": "BETA-C01",
                            "tag": "VERIFIED",
                            "statement": "Batch streaming incurs a 650ms PCIe transfer delay under production loads.",
                            "source_hash": shash,
                            "source_url": "https://arxiv.org/abs/2406.9999",
                            "verbatim_quote": "In continuous batch streaming, PCIe 4.0 transfers introduce a 650ms delay, yielding total latency > 800ms.",
                        }
                    ],
                    "methodological_critiques": [
                        {
                            "target_assertion": "FPGA-accelerated Poseidon provers achieve sub-200ms latency on 2^20 constraints.",
                            "critique": "Benchmark isolates compute kernel and ignores host-to-device PCIe latency in pipelined batches.",
                            "evidence_hash": shash,
                        }
                    ],
                    "negative_knowledge": [
                        {
                            "query": "Zero-latency PCIe streaming ZK provers",
                            "finding": "No architecture eliminates bus transfer overhead without on-chip memory > 128GB.",
                        }
                    ],
                }
        else:
            prompt = self._scope_prompt("Beta", scope, scope_id)
            if self.mode == "audit":
                system_prompt = self.prompts_dir / "agent_code_auditor.md"
            elif self.mode == "scout":
                system_prompt = self.prompts_dir / "agent_oss_scout.md"
            elif self.mode == "brainstorm":
                system_prompt = self.prompts_dir / "agent_brainstormer.md"
            elif self.mode == "darkharvest":
                system_prompt = self.prompts_dir / "agent_darkharvest.md"
            else:
                system_prompt = self.prompts_dir / "agent_beta_antithesis.md"
            transcript = self.run_claude_process(
                prompt, system_prompt_file=system_prompt, role="beta"
            )
            dossier_path = (
                self.state_machine.get_scope_dir(scope_id) / "beta_dossier.json"
            )
            dossier = self._load_agent_dossier(
                dossier_path,
                scope_id,
                "beta",
                transcript,
                aliases=MODE_DOSSIER_ALIASES.get(self.mode, ()),
            )

        self.state_machine.record_agent_completion(scope_id, "beta", dossier)
        print(f"  [Beta] ✅ Completed Agent Beta for [{scope_id}].")

    def execute_scope_dialectic(self, scope: Dict[str, Any]) -> Dict[str, Any]:
        """Dispatches Agent Alpha and Agent Beta concurrently. Returns the audit report."""
        scope_id = scope["scope_id"]
        print(
            f"\n⚡ [Swarm Dispatch] Launching Dialectic Pair for [{scope_id}]: '{scope.get('title')}'"
        )
        self.state_machine.update_scope_status(scope_id, ScopeStatus.RUNNING_PARALLEL)

        with ThreadPoolExecutor(max_workers=2) as executor:
            future_alpha = executor.submit(self.run_agent_alpha, scope)
            future_beta = executor.submit(self.run_agent_beta, scope)

            # Wait for both
            future_alpha.result()
            future_beta.result()

        # Phase 4: Run Epistemic Auditor
        print(
            f"⚖️ [Auditor] Auditing evidence & computing divergence for [{scope_id}]..."
        )
        constitution = None
        if self.domain_pack:
            from runner.refinement import load_domain_pack

            constitution = load_domain_pack(self.domain_pack)
        audit_report = self.auditor.audit_scope(
            scope_id, constitution=constitution, mode=self.mode
        )
        summary = audit_report["summary"]
        print(
            f"  [Audit Result] Score: {summary['epistemic_score']}/1.0 | Divergence: {summary['divergence_score']} | Verified: {summary['verified_passed']} | Rejected: {summary['unverified_rejected']}"
        )
        return audit_report

    def _auction_dispatch(self, ready_scopes: List[Dict[str, Any]]) -> None:
        """Stream F: order the ready batch by expected information gain."""
        from runner.auctioneer import (
            estimate_tokens,
            record_scope_telemetry,
            score_scopes,
        )

        scored = score_scopes(ready_scopes, base_dir=self.base_dir)
        bids = {s.get("scope_id"): b for b, s in scored}
        for _bid, ordered_scope in scored:
            audit_report = self.execute_scope_dialectic(ordered_scope)
            summary = (audit_report or {}).get("summary", {})
            sid = ordered_scope.get("scope_id", "")
            record_scope_telemetry(
                self.base_dir,
                sid,
                # tokens_used is a chars/4 ESTIMATE — flagged approximation.
                tokens_used=estimate_tokens("x" * self._dossier_chars(sid)),
                verified_claims=summary.get("verified_passed", 0),
                bid=bids.get(sid),
            )

    def _dossier_chars(self, scope_id: str) -> int:
        scope_dir = self.state_machine.get_scope_dir(scope_id)
        total = 0
        for name in ("alpha_dossier.json", "beta_dossier.json"):
            p = scope_dir / name
            if p.exists():
                total += p.stat().st_size
        return total

    def _run_scope_batches(self) -> bool:
        """Drive scopes by DAG until complete. False on deadlock."""
        while True:
            ready_scopes = self.state_machine.get_ready_scopes()
            if not ready_scopes:
                manifest = self.state_machine.load_global_manifest()
                if self._all_scopes_complete(manifest):
                    return True
                print("[ERROR] Deadlock in scope dependency graph.", file=sys.stderr)
                self.state_machine.update_session_status(SessionStatus.FAILED)
                return False
            # "auction" reorders each ready batch by expected information
            # gain; "dag" keeps legacy dependency order.
            if self.allocation == "auction":
                self._auction_dispatch(ready_scopes)
            else:
                for scope in ready_scopes:
                    self.execute_scope_dialectic(scope)
            self._write_progress()

    def _all_scopes_complete(self, manifest: Dict[str, Any]) -> bool:
        return all(
            self.state_machine.reconcile_scope_status(s["scope_id"]).get("status")
            == ScopeStatus.COMPLETE.value
            for s in manifest["scopes"]
        )

    def _host_websearch_provider(self) -> Optional[str]:
        """The host-reported explicit websearch provider (env > config).

        The OpenCode plugin knows the user's ``websearch.provider``; when it (or
        an operator) exports ``IUMBTEMS_WEBSEARCH_PROVIDER`` the run path must
        feed it to preflight so the banner names the provider actually in play
        instead of re-deriving a different one. Delegates to the shared helper so
        ``iumbtems_doctor`` resolves the same provider.
        """
        from runner.preflight import host_websearch_provider

        return host_websearch_provider(self.config)

    def run_swarm(self, objective: str, frontier_file: Optional[Path] = None):
        """Full end-to-end execution loop.

        Returns a status string: ``"completed"``, ``"dry-run"``, ``"halted"``
        (a fail-fast preflight refusal; the CLI maps this to
        :data:`EXIT_PREFLIGHT_HALT`), or ``"incomplete"``.
        """
        start_time = datetime.now(timezone.utc)
        print("=" * 70)
        print(
            f"🌟 EPISTEMIC SWARM: HIGH-INTEGRITY RESEARCH HARNESS [{self.mode.upper()} MODE]"
        )
        print(
            f"   Engine: {self.engine.upper()} | Depth: {self.depth} | Dir: {self.base_dir}"
        )
        if self.divergence_threshold_configured:
            print(f"   Divergence threshold (advisory): {self.divergence_threshold}")
        print(
            f"   Workspace: {self.base_dir} | Manifest: "
            f"{self.state_machine.manifest_file.name} | Agent cwd: "
            f"{_agent_cwd(self.project_root)}"
        )
        print("=" * 70)

        # Retrieval telemetry baseline: count only events from this run.
        self._retrieval_offset = _retrieval_offset(self.base_dir)
        print(f"   {self._retrieval_banner()}")

        # Preflight: workspace, backend binary, engine reachability, write test.
        from runner.preflight import format_report, preflight

        # The CLI `--domain-pack` lives on the runner, not the persisted config,
        # so fold it in or the strict-brainstorm gate would miss it and proceed
        # ungrounded. `since` scopes the cost count to THIS run (the probe is
        # excluded upstream so a zero-search run reports 0).
        preflight_config = self.config
        if self.domain_pack:
            preflight_config = {**self.config, "domain_pack": self.domain_pack}
        self._preflight = preflight(
            self.base_dir,
            mode=self.mode,
            config=preflight_config,
            mock_mode=self.mock_mode,
            probe=os.environ.get("IUMBTEMS_PREFLIGHT_PROBE", "1").strip().lower()
            not in ("0", "false", "no", "off"),
            host_provider=self._host_websearch_provider(),
            since=self._retrieval_offset,
        )
        print(format_report(self._preflight))
        print("=" * 70)
        self.state_machine.record_preflight(
            self._preflight,
            backend=self._preflight.get("backend", {}).get("family"),
            # Advisory only, and only when configured non-default (R3).
            divergence_threshold=(
                self.divergence_threshold
                if self.divergence_threshold_configured
                else None
            ),
        )

        # Mode-aware search availability gate (deliverable 7): fail fast BEFORE
        # any agent spawns when a retrieval-requiring mode has no usable search.
        # Mock runs never retrieve, so they are exempt. A dry run validates and
        # reports but must never halt (it spawns nothing to ground).
        gate = (self._preflight or {}).get("search_gate") or {}
        self._search_gate = gate
        if gate.get("action") == "halt" and not self.mock_mode and not self.dry_run:
            print(f"\n⛔ PREFLIGHT HALT ({gate.get('reason')}): {gate.get('message')}")
            self._halted = True
            try:
                self.state_machine.update_session_status(SessionStatus.FAILED)
            except Exception:  # noqa: BLE001 - halting must not raise
                pass
            return "halted"

        if self.dry_run:
            print("\n🧪 [Dry Run] configuration validated; no agents spawned.")
            if gate.get("action") == "halt":
                print(
                    "   (dry run: this configuration would HALT a real run — "
                    f"{gate.get('reason')})"
                )
            return "dry-run"

        # 1. Orchestrate (skip when resuming a session that already has scopes)
        resumed = False
        if self.resume:
            try:
                existing = self.state_machine.load_global_manifest().get("scopes") or []
            except FileNotFoundError:
                existing = []
            resumed = bool(existing)
            if resumed:
                print(f"   ↻ resume: {len(existing)} scope(s) already recorded")
        if not resumed:
            self.orchestrate_objective(objective, frontier_file)

        # Advisory divergence reference: re-assert after orchestration, which
        # (re)initializes the manifest and would otherwise drop the field
        # recorded with record_preflight. Only when configured non-default (R3).
        if self.divergence_threshold_configured:
            try:
                self.state_machine.set_manifest_fields(
                    divergence_threshold=self.divergence_threshold
                )
            except Exception:  # noqa: BLE001 - advisory bookkeeping never fails a run
                pass

        # 2. Execute scopes according to DAG
        if not self._run_scope_batches():
            return "incomplete"

        # 3. Master Synthesis Compilation
        print(
            f"\n📜 [Phase 5: Master Synthesis] Aggregating {self.mode.upper()} dossiers..."
        )
        report_path = self._compile_master_synthesis(objective)
        self.state_machine.update_session_status(SessionStatus.COMPLETED)
        self._write_orphan_report()

        duration = (datetime.now(timezone.utc) - start_time).total_seconds()
        print(f"   {self._retrieval_banner()}")
        self._warn_version_drift()
        self._report_stdout_recovery()
        print(f"\n🎉 Swarm run completed in {duration:.1f}s. Report: {report_path}")
        return "completed"

    def _write_progress(self) -> None:
        """Per-scope status snapshot so a long run is observable while it runs."""
        try:
            manifest = self.state_machine.load_global_manifest()
            rows = [
                {
                    "scope_id": scope["scope_id"],
                    "status": self.state_machine.reconcile_scope_status(
                        scope["scope_id"]
                    ).get("status"),
                }
                for scope in manifest.get("scopes", [])
            ]
            (self.base_dir / "progress.json").write_text(
                json.dumps(rows, indent=2), encoding="utf-8"
            )
        except Exception:  # noqa: BLE001 - progress must not fail a run
            return

    def _report_stdout_recovery(self) -> None:
        """Surface dossiers salvaged from stdout — the file-write path failed (#6 2.9)."""
        try:
            manifest = self.state_machine.load_global_manifest()
        except Exception:  # noqa: BLE001
            return
        recovered = []
        for scope in manifest.get("scopes", []):
            scope_dir = self.state_machine.get_scope_dir(scope["scope_id"])
            for name in ("alpha_dossier.json", "beta_dossier.json"):
                path = scope_dir / name
                if not path.exists():
                    continue
                try:
                    if json.loads(path.read_text(encoding="utf-8")).get(
                        "recovered_from_stdout"
                    ):
                        recovered.append(f"{scope['scope_id']}/{name}")
                except (OSError, ValueError):
                    continue
        if recovered:
            print(
                f"   ⚠️ {len(recovered)} dossier(s) recovered from stdout "
                f"(agent file write failed): {', '.join(recovered[:4])}"
            )

    def _warn_version_drift(self) -> None:
        """Warn when the installed plugin version changed during the run (#6 2.7)."""
        try:
            from runner.preflight import plugin_version

            current = plugin_version()
            recorded = self.state_machine.load_global_manifest().get("plugin_version")
        except Exception:  # noqa: BLE001
            return
        if recorded and current and recorded != current:
            print(
                f"   ⚠️ plugin version changed mid-run: {recorded} -> {current}; "
                "artifacts may span versions"
            )

    def _write_orphan_report(self) -> None:
        """Record scope dirs absent from every manifest (mark-only, never delete)."""
        try:
            orphans = self.state_machine.find_orphan_scopes()
        except Exception:  # noqa: BLE001 - hygiene must not fail the run
            return
        if not orphans:
            return
        path = self.base_dir / "orphans.json"
        try:
            path.write_text(json.dumps(orphans, indent=2), encoding="utf-8")
        except OSError:
            return
        print(
            f"   ⚠️ {len(orphans)} orphaned scope dir(s) not referenced by any "
            f"manifest -> {path.name} (not deleted)"
        )

    def _retrieval_banner(self) -> str:
        """One-line retrieval summary for the current run (issue #3).

        `N queries, M results, K cached` makes an ungrounded run obvious at a
        glance instead of inferring it from an empty `sources/`.
        """
        since = getattr(self, "_retrieval_offset", 0)
        stats = _retrieval_summary(self.base_dir, since=since)
        return (
            f"retrieval: {stats['queries']} queries, {stats['results']} results, "
            f"{stats['cached']} cached"
        )

    def _collect_scope_totals(
        self, manifest: Dict[str, Any], synthesis_lines: List[str]
    ) -> Tuple[int, int, List[float], List[str]]:
        """Fold per-scope audit/synthesis artifacts into running totals."""
        total_verified = 0
        total_rejected = 0
        all_divergences: List[float] = []
        verdicts: List[str] = []
        for scope in manifest["scopes"]:
            sid = scope["scope_id"]
            scope_dir = self.state_machine.get_scope_dir(sid)
            audit_file = scope_dir / "audit_report.json"
            synth_file = scope_dir / "scope_synthesis.md"

            if audit_file.exists():
                ar = json.loads(audit_file.read_text(encoding="utf-8"))
                summary = ar["summary"]
                total_verified += summary["verified_passed"]
                total_rejected += summary["unverified_rejected"]
                all_divergences.append(summary["divergence_score"])
                verdicts.append(summary.get("verdict", ""))

            if synth_file.exists():
                synthesis_lines.append(synth_file.read_text(encoding="utf-8"))
                synthesis_lines.append("\n---\n")
        return total_verified, total_rejected, all_divergences, verdicts

    def _grounding_sentence(self, verified: int, rejected: int, warnings: int) -> str:
        """Executive summary that matches the audit — never claims certainty it lacks."""
        if verified == 0 and warnings:
            return (
                "⚠️ **WARNING_LOW_GROUNDING**: this run verified 0 primary citations "
                f"({rejected} claim(s) rejected). Treat the findings below as unverified "
                "hypotheses, not evidence."
            )
        if warnings:
            return (
                f"⚠️ {warnings} scope(s) reported WARNING_LOW_GROUNDING. "
                f"{verified} primary citation(s) verified; {rejected} rejected."
            )
        return (
            f"Compiled by the IUMBTEMS dialectic harness ({self.mode} mode); "
            f"{verified} primary citation(s) verified against the content-addressed "
            "source cache."
        )

    def _write_report(self, filename: str, lines: List[str]) -> Path:
        path = self.base_dir / filename
        path.write_text("\n".join(lines), encoding="utf-8")
        return path

    def _compile_master_synthesis(self, objective: str) -> Path:
        manifest = self.state_machine.load_global_manifest()
        mode_titles = {
            "audit": "Codebase Architectural & Security Audit",
            "scout": "Open-Source Software Discovery & Clean-Room Blueprint",
            "hybrid": "Hybrid Codebase & Literature Epistemic Report",
            "brainstorm": "Lateral Brainstorm & Speculative Ideation Portfolio",
            "darkharvest": "Product Competitor Teardown & Clean-Room Harvest",
            "research": "Master Epistemic Research Report",
        }
        title = mode_titles.get(self.mode, "Master Epistemic Research Report")

        # Collect per-scope sections first so the executive summary can reflect
        # the actual audit verdict instead of asserting certainty we don't have.
        scope_sections: List[str] = []
        total_verified, total_rejected, all_divergences, verdicts = (
            self._collect_scope_totals(manifest, scope_sections)
        )
        avg_div = round(sum(all_divergences) / max(1, len(all_divergences)), 2)
        warnings = sum(1 for v in verdicts if v == "WARNING_LOW_GROUNDING")

        synthesis_lines = [
            f"# {title}: {objective}\n",
            f"**Session ID**: `{manifest['session_id']}` | **Mode**: `{self.mode.upper()}` | **Engine**: `{self.engine}` | **Generated**: `{manifest['updated_at']}`\n",
            "## Executive Summary",
            self._grounding_sentence(total_verified, total_rejected, warnings) + "\n",
            f"{self._retrieval_banner()}\n",
            "## Scope Findings & Dialectic Balance Sheets\n",
            *scope_sections,
            "\n## Swarm Epistemic Audit Totals\n",
            f"- **Total Verified Primary Citations**: `{total_verified}`",
            f"- **Total Unverified Claims Purged**: `{total_rejected}`",
            f"- **Mean Swarm Divergence Score**: `{avg_div}`",
        ]
        # Only emitted when the threshold is configured non-default (R3).
        if self.divergence_threshold_configured:
            synthesis_lines.append(
                f"- **Advisory Divergence Threshold**: `{self.divergence_threshold}` "
                "(recorded for reference; never gates a verdict)"
            )
        synthesis_lines.append(
            f"- **Scopes Flagged WARNING_LOW_GROUNDING**: `{warnings}`"
        )

        final_path = self._write_report("final_synthesis.md", synthesis_lines)

        # Also write specialized report files for audit/scout/brainstorm/darkharvest.
        specialized = {
            "audit": "code_audit_report.md",
            "scout": "oss_scout_report.md",
            "brainstorm": "brainstorm_report.md",
            "darkharvest": "darkharvest_report.md",
        }.get(self.mode)
        if specialized:
            return self._write_report(specialized, synthesis_lines)
        return final_path


def main():
    parser = argparse.ArgumentParser(
        description="Epistemic Swarm Dialectic Research Runner"
    )
    parser.add_argument(
        "--objective", type=str, required=True, help="Research question or objective"
    )
    parser.add_argument(
        "--frontier", type=str, help="Path to settled frontier.json from /grilling"
    )
    parser.add_argument(
        "--mock-claude",
        action="store_true",
        help="Run with synthetic test data without invoking Claude Code",
    )
    parser.add_argument(
        "--dir", default=".research", help="Path to .research workspace"
    )
    parser.add_argument(
        "--mode",
        choices=["research", "audit", "scout", "hybrid", "brainstorm", "darkharvest"],
        default=None,
        help="Operating mode",
    )
    parser.add_argument(
        "--seeds",
        type=str,
        default=None,
        help="Darkharvest: comma-separated seed inspiration repo URLs",
    )
    parser.add_argument(
        "--max-repos",
        type=int,
        default=None,
        help="Darkharvest: cap on total competitors (default 10, recommended 6 live)",
    )
    parser.add_argument(
        "--per-repo-mb",
        type=int,
        default=None,
        help="Darkharvest: per-repo scan cap in MB (default 100)",
    )
    parser.add_argument(
        "--per-repo-timeout",
        type=int,
        default=None,
        help="Darkharvest: per-repo fetch timeout in seconds (default 300)",
    )
    parser.add_argument(
        "--engine",
        choices=["duckduckgo", "brave", "firecrawl", "searxng"],
        default=None,
        help="Search engine",
    )
    parser.add_argument(
        "--depth",
        "--iterations",
        type=int,
        default=None,
        help="Max dialectic depth / iterations",
    )

    # Stream E: per-agent backend/model overrides (CLI > env > config).
    parser.add_argument(
        "--model-alpha",
        type=str,
        default=None,
        help="Model id for Agent Alpha (thesis)",
    )
    parser.add_argument(
        "--model-beta",
        type=str,
        default=None,
        help="Model id for Agent Beta (antithesis)",
    )
    parser.add_argument(
        "--beta-backend",
        type=str,
        nargs="+",
        default=None,
        help="Backend command list for Beta, e.g. --beta-backend ollama run qwen3",
    )
    parser.add_argument(
        "--allocation",
        choices=["dag", "auction"],
        default=None,
        help="Scope allocation policy (default: config/dag; auction = Frontier Markets)",
    )
    parser.add_argument(
        "--domain-pack",
        type=str,
        default=None,
        help="Regulated Domain Pack id (config/domain_packs/<id>.json), e.g. biopharma",
    )
    parser.add_argument(
        "--backend",
        choices=["auto", "claude", "opencode"],
        default=None,
        help="Agent runtime backend for both roles (default: auto = host-native; explicit beats env/config)",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Continue an existing session instead of re-orchestrating",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate config/backends/engine and exit without spawning agents",
    )

    args = parser.parse_args()
    frontier_path = Path(args.frontier) if args.frontier else None

    agent_overrides: Dict[str, Dict[str, Any]] = {}
    if args.backend and args.backend != "auto":
        argv = ["claude", "-p"] if args.backend == "claude" else ["opencode", "run"]
        agent_overrides.setdefault("alpha", {})["backend"] = argv
        agent_overrides.setdefault("beta", {})["backend"] = argv
    if args.model_alpha:
        agent_overrides.setdefault("alpha", {})["model"] = args.model_alpha
    if args.model_beta:
        agent_overrides.setdefault("beta", {})["model"] = args.model_beta
    if args.beta_backend:
        agent_overrides.setdefault("beta", {})["backend"] = args.beta_backend

    runner = SwarmRunner(
        base_dir=Path(args.dir),
        mock_mode=args.mock_claude,
        mode=args.mode,
        engine=args.engine,
        depth=args.depth,
        agent_overrides=agent_overrides or None,
        allocation=args.allocation,
        domain_pack=args.domain_pack,
        resume=getattr(args, "resume", False),
        dry_run=getattr(args, "dry_run", False),
    )
    status = runner.run_swarm(args.objective, frontier_file=frontier_path)
    if status == "halted":
        # Fail-fast refusal: exit non-zero so CI/scripts cannot read a halted
        # run as success. Dry runs return "dry-run" and stay zero (they only
        # validate and report).
        raise SystemExit(EXIT_PREFLIGHT_HALT)


if __name__ == "__main__":
    main()
