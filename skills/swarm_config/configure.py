#!/usr/bin/env python3
"""
Interactive Configuration Manager for IUMBTEMS Epistemic Swarm.
Reads, modifies, and persists research parameters in .research/config.json.

Persistence contract (phase 01 `01-config-contract`):

* `DEFAULT_CONFIG` mirrors `runner.schemas.CONFIG_DEFAULTS` (single source of
  truth); a test asserts they never drift.
* `save_config` is the single writer: it takes the workspace advisory lock
  (`.research/.config.lock`), merges over whatever is already on disk so unknown
  keys survive, validates against the canonical CONFIG schema, and publishes via
  a unique temp file + `os.replace` (never a truncating write).
* An optional `expected_hash` guard rejects a stale write with a structured
  error and a fresh snapshot; nothing is written on mismatch.
* The atomic-write/lock primitives come from `runner.state_machine`; a
  self-contained fallback (same shape as `skills/grilling/socratic_tree.py`)
  keeps this file runnable where the `runner/` package is not importable.
"""

import copy
import hashlib
import json
import os
import re
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

DEFAULT_RESEARCH_DIR = ".research"


def _fallback_atomic_write_json(path: Path, data: Any) -> None:
    """Self-contained atomic JSON write: unique temp file + os.replace."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        dir=str(path.parent), prefix=path.name + ".", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


@contextmanager
def _fallback_file_lock(lock_path: Path):
    """Self-contained cross-process advisory lock; no-op without fcntl."""
    try:
        import fcntl as _fcntl
    except ImportError:  # pragma: no cover - non-POSIX
        _fcntl = None
    if _fcntl is None:
        yield
        return
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "a+", encoding="utf-8") as fh:
        _fcntl.flock(fh.fileno(), _fcntl.LOCK_EX)
        try:
            yield
        finally:
            _fcntl.flock(fh.fileno(), _fcntl.LOCK_UN)


# Reuse the runner's canonical primitives + canonical schema rather than
# re-declaring them. The import is OPTIONAL: the skill must still run when the
# `runner/` package is not importable (mirrors socratic_tree.py).
try:
    PROJECT_ROOT = Path(__file__).resolve().parents[2]
    if str(PROJECT_ROOT) not in sys.path:
        sys.path.insert(0, str(PROJECT_ROOT))
    from runner.schema_validate import validate as _schema_validate  # noqa: E402
    from runner.schemas import CONFIG as _CONFIG_SCHEMA  # noqa: E402
    from runner.schemas import CONFIG_DEFAULTS as _CANONICAL_DEFAULTS  # noqa: E402
    from runner.state_machine import _atomic_write_json, _file_lock  # noqa: E402
except ImportError:  # pragma: no cover - standalone skill copy
    _schema_validate = None
    _CONFIG_SCHEMA = None
    _CANONICAL_DEFAULTS = None
    _atomic_write_json = _fallback_atomic_write_json
    _file_lock = _fallback_file_lock


# Literal fallback for standalone runs (runner/ not importable). It must stay
# in sync with the canonical `runner.schemas.CONFIG_DEFAULTS`; the drift test
# `TestFallbackDrift` in `runner/tests/test_swarm_config.py` asserts equality.
_FALLBACK_DEFAULT_CONFIG: Dict[str, Any] = {
    "search_engine": "duckduckgo",
    "max_iterations": 2,
    "divergence_threshold": 0.75,
    "mode": "research",  # "research", "audit", "scout", "hybrid", "brainstorm", "darkharvest"
    "backend": "auto",  # "auto" (host-native) | "claude" | "opencode"
    "cache_raw_markdown": True,
    "cache_ttl_days": None,  # None = webcache's per-domain TTL policy
    "search_timeout_s": None,  # None = each surface's built-in timeout
    "searxng_url": None,  # None = SEARXNG_URL env untouched
    "license_whitelist": ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC"],
    "output_dir": DEFAULT_RESEARCH_DIR,  # deprecated: display-only, never a path
    # Scope allocation policy (Stream F): "dag" = legacy dependency-first
    # order; "auction" = Frontier Markets (highest expected-information-gain
    # bid first). Default "dag" preserves existing behavior exactly.
    "allocation": "dag",
    # Regulated Domain Pack id (Stream G) or null for the legacy constitution.
    # Loaded via runner.refinement.load_domain_pack (config/domain_packs/).
    "domain_pack": None,
    # Quote verification policy (see runner/schemas.py CONFIG).
    "verify": {"min_fuzzy_confidence": 0.88},
    # Per-agent backends. Asymmetry is the point (Stream E): Alpha and Beta on
    # different model families/weights probe divergence that prompt-level
    # red-teaming cannot reach. `backend` is a command list, not just a model
    # string, because cross-FAMILY means non-Claude processes.
    # None means "fall through to the host-native default" (claude -p on
    # Claude Code, opencode run on OpenCode) — explicit values still win.
    # mock mode never builds or spawns these commands.
    "agents": {
        "alpha": {"backend": None, "model": None, "opencode_agent": None},
        "beta": {"backend": None, "model": None, "opencode_agent": None},
    },
    "opencode_auto": None,  # None = enabled unless IUMBTEMS_OPENCODE_AUTO says no
    "opencode_agent": None,  # None = inline the prompt, no --agent
    # Persisted MCP-server toggle map (phase 03); mirrors CONFIG_DEFAULTS.
    "mcp_servers": {},
}

DEFAULT_CONFIG: Dict[str, Any] = copy.deepcopy(
    _CANONICAL_DEFAULTS if _CANONICAL_DEFAULTS is not None else _FALLBACK_DEFAULT_CONFIG
)


# Historical pre-0.7.6 default that was persisted verbatim into user configs.
# A per-role pin equal to this value, while the top-level `backend` is not an
# explicit "claude", is a stale default rather than a deliberate choice: it must
# not override the host-native backend (opencode on OpenCode). Explicit intent
# lives in `backend: "claude"` or `IUMBTEMS_BACKEND_<ROLE>`.
LEGACY_AGENT_BACKEND_PINS = (["claude", "-p"],)

AGENT_ROLES = ("alpha", "beta")


# ---------------------------------------------------------------------------
# structured errors
# ---------------------------------------------------------------------------


class ConfigError(Exception):
    """Structured config failure: stable code + message + details.

    Mirrors the `runner.errors.SwarmError` shape without importing it, so this
    module stays runnable standalone. MCP/CLI surfaces render `to_dict()`.
    """

    code = "CONFIG_ERROR"

    def __init__(self, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.message = message
        self.details: Dict[str, Any] = dict(details or {})

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"code": self.code, "message": self.message}
        if self.details:
            out["details"] = self.details
        return out

    def __str__(self) -> str:
        lines = [f"[{self.code}] {self.message}"]
        for problem in self.details.get("errors") or []:
            lines.append(f"  - {problem}")
        if self.details.get("current_hash"):
            lines.append(f"  current_hash: {self.details['current_hash']}")
        return "\n".join(lines)


class ConfigValidationError(ConfigError):
    """The candidate config violates the canonical CONFIG schema."""

    code = "CONFIG_VALIDATION_FAILED"

    def __init__(self, problems: List[str]):
        errors = [str(p) for p in problems]
        super().__init__(
            f"Config validation failed with {len(errors)} violation(s); nothing written.",
            details={"errors": errors},
        )

    @property
    def errors(self) -> List[str]:
        return list(self.details.get("errors") or [])


class ConfigStaleError(ConfigError):
    """`expected_hash` no longer matches the file on disk; nothing written."""

    code = "CONFIG_STALE"

    def __init__(
        self,
        expected_hash: str,
        current_hash: Optional[str],
        snapshot: Dict[str, Any],
    ):
        details: Dict[str, Any] = {
            "expected_hash": expected_hash,
            "current_hash": current_hash,
            "written": False,
        }
        details.update(snapshot)
        super().__init__(
            "Config changed on disk since it was read; refusing the stale write. "
            "Re-read the fresh snapshot and retry.",
            details=details,
        )


class ConfigHashError(ConfigError):
    """`expected_hash` is not a full sha256 / unique-prefix hex string."""

    code = "CONFIG_INVALID_EXPECTED_HASH"

    def __init__(self, expected_hash: Any):
        super().__init__(
            "expected_hash must be 8-64 hex characters (a full SHA-256 or a "
            "unique prefix of at least 8 hex chars).",
            details={"expected_hash": str(expected_hash)},
        )


# ---------------------------------------------------------------------------
# paths + snapshots
# ---------------------------------------------------------------------------


def get_config_path(base_dir: str = DEFAULT_RESEARCH_DIR) -> Path:
    return Path(base_dir) / "config.json"


def get_lock_path(base_dir: str = DEFAULT_RESEARCH_DIR) -> Path:
    return Path(base_dir) / ".config.lock"


def config_hash(base_dir: str = DEFAULT_RESEARCH_DIR) -> Optional[str]:
    """SHA-256 of the config file's exact bytes, or None when absent.

    The hash covers the file as written (whitespace included), so it doubles as
    an optimistic-concurrency version for `expected_hash` / the RPC bridge.
    """
    cfg_file = get_config_path(base_dir)
    if not cfg_file.is_file():
        return None
    return hashlib.sha256(cfg_file.read_bytes()).hexdigest()


def snapshot(base_dir: str = DEFAULT_RESEARCH_DIR) -> Dict[str, Any]:
    """Fresh read-only snapshot: path, existence, file hash, effective config."""
    cfg_file = get_config_path(base_dir)
    return {
        "path": str(cfg_file),
        "exists": cfg_file.is_file(),
        "hash": config_hash(base_dir),
        "config": load_config(base_dir),
    }


def normalize_expected_hash(expected_hash: Any) -> Optional[str]:
    """Validate/normalize an `expected_hash` guard; None means "no guard".

    Accepts a full 64-hex SHA-256 or a unique prefix of at least 8 hex chars
    (R4: 4-hex prefixes are rejected as too collision-prone for a guard). `None`
    and the empty string mean "no guard"; anything else malformed raises
    `ConfigHashError`.
    """
    if expected_hash is None:
        return None
    value = str(expected_hash).strip().lower()
    if not value:
        return None
    if not re.fullmatch(r"[0-9a-f]{8,64}", value):
        raise ConfigHashError(expected_hash)
    return value


def _hash_matches(expected_hash: str, current_hash: Optional[str]) -> bool:
    """True when the (already normalized) expected hash prefixes the current one."""
    if not expected_hash or not current_hash:
        return False
    return current_hash.startswith(expected_hash)


# ---------------------------------------------------------------------------
# merging + validation
# ---------------------------------------------------------------------------


def merge_config(base: Any, updates: Any) -> Any:
    """Recursively merge `updates` over `base` (updates win; lists replace)."""
    if not isinstance(base, dict) or not isinstance(updates, dict):
        return copy.deepcopy(updates)
    merged = copy.deepcopy(base)
    for key, value in updates.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = merge_config(merged[key], value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


def validate_config(cfg: Any) -> List[str]:
    """Canonical-schema violations (dotted paths); empty list == valid.

    Degrades to `[]` with a warning when the runner package is not importable
    (standalone skill copy) — the canonical CLI/MCP surfaces always validate.
    """
    if _schema_validate is None or _CONFIG_SCHEMA is None:
        sys.stderr.write(
            "[swarm-config] Warning: runner schema validator unavailable; "
            "skipping canonical validation.\n"
        )
        return []
    return _schema_validate(cfg, _CONFIG_SCHEMA)


def _read_raw_config(cfg_file: Path) -> Optional[Dict[str, Any]]:
    """Best-effort raw JSON object on disk (None when absent/malformed)."""
    try:
        data = json.loads(cfg_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


# ---------------------------------------------------------------------------
# load / save
# ---------------------------------------------------------------------------


def _merge_agents(default_agents: Any, file_agents: Any) -> Dict[str, Any]:
    """Deep-merge the per-role `agents` block, one role/key at a time.

    A shallow `merged.update(data)` let a single on-disk role key clobber the
    whole default block, which silently re-pinned every agent to whatever the
    user's file happened to contain (the host-native default was never reached).
    """
    merged = copy.deepcopy(default_agents) if isinstance(default_agents, dict) else {}
    if not isinstance(file_agents, dict):
        return merged
    for role, role_cfg in file_agents.items():
        if not isinstance(role_cfg, dict):
            # Preserve unexpected shapes verbatim rather than crashing; the
            # backend resolver tolerates non-dict role configs.
            merged[role] = copy.deepcopy(role_cfg)
            continue
        base = merged.get(role)
        if isinstance(base, dict):
            base.update(copy.deepcopy(role_cfg))
        else:
            merged[role] = copy.deepcopy(role_cfg)
    return merged


def migrate_legacy_agent_backends(cfg: Dict[str, Any]) -> bool:
    """Drop stale pre-0.7.6 `["claude", "-p"]` pins in place; True if changed.

    Only fires when the top-level backend is not an explicit "claude", so a user
    who deliberately selected Claude is never silently switched to something
    else. To keep Claude on an OpenCode host, set `backend: "claude"`.
    """
    if str(cfg.get("backend") or "auto").strip().lower() == "claude":
        return False
    agents = cfg.get("agents")
    if not isinstance(agents, dict):
        return False
    changed = False
    for role in AGENT_ROLES:
        role_cfg = agents.get(role)
        if (
            isinstance(role_cfg, dict)
            and role_cfg.get("backend") in LEGACY_AGENT_BACKEND_PINS
        ):
            role_cfg["backend"] = None
            changed = True
    return changed


def load_config(base_dir: str = DEFAULT_RESEARCH_DIR) -> Dict[str, Any]:
    """Load config merged over defaults. Pure — never writes to disk.

    Applies the legacy-pin migration in memory so a stale config stops forcing
    Claude immediately; `heal_config` persists that migration on next touch.
    Unknown keys are preserved verbatim (they are part of the contract's
    forward-compatibility rule).
    """
    base = copy.deepcopy(DEFAULT_CONFIG)
    cfg_file = get_config_path(base_dir)
    if not cfg_file.exists():
        return base
    try:
        with open(cfg_file, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        sys.stderr.write(
            f"[swarm-config] Warning: Failed to parse {cfg_file}: {e}. Using defaults.\n"
        )
        return base
    if not isinstance(data, dict):
        sys.stderr.write(
            f"[swarm-config] Warning: {cfg_file} is not a JSON object. Using defaults.\n"
        )
        return base
    merged: Dict[str, Any] = {**base, **data}
    merged["agents"] = _merge_agents(base.get("agents", {}), data.get("agents"))
    # Object-valued policy blocks merge key-by-key so a partial file block keeps
    # the defaults of keys it does not mention.
    if isinstance(data.get("verify"), dict) and isinstance(base.get("verify"), dict):
        merged["verify"] = {**base["verify"], **data["verify"]}
    migrate_legacy_agent_backends(merged)
    return merged


def heal_config(base_dir: str = DEFAULT_RESEARCH_DIR) -> bool:
    """Persist a legacy agent-backend migration to disk; True if rewritten.

    `load_config` stays side-effect free; the CLI and MCP surfaces call this so
    an affected install self-heals instead of re-pinning Claude on every save.
    The write is guarded by the hash of the bytes this call read, so a migration
    never clobbers a concurrent writer (it simply defers to the next touch).

    The would-be-persisted dict is validated first (R1): a file that already
    fails the canonical schema is NOT rewritten — persisting it would legitimise
    the invalid values and feed them to SwarmRunner. The migration then stays in
    memory only, and a warning names every violation.
    """
    cfg_file = get_config_path(base_dir)
    if not cfg_file.exists():
        return False
    try:
        raw_bytes = cfg_file.read_bytes()
        raw = json.loads(raw_bytes.decode("utf-8"))
    except Exception:
        return False
    if not isinstance(raw, dict):
        return False
    if not migrate_legacy_agent_backends(raw):
        return False
    candidate = load_config(base_dir)
    problems = validate_config(candidate)
    if problems:
        sys.stderr.write(
            "[swarm-config] Warning: not persisting the legacy ['claude', '-p'] "
            f"migration: {cfg_file} fails canonical validation. Fix the values "
            "below (iumbtems_config / configure.py) and re-run:\n"
            + "".join(f"  - {problem}\n" for problem in problems)
        )
        return False
    try:
        save_config(
            candidate,
            base_dir,
            expected_hash=hashlib.sha256(raw_bytes).hexdigest(),
        )
    except ConfigStaleError:
        # Someone else wrote first; their file heals on the next touch.
        return False
    except ConfigValidationError:
        # A concurrent writer made the file invalid between our read and the
        # lock; never persist a schema-rejected dict.
        return False
    return True


def save_config(
    cfg: Dict[str, Any],
    base_dir: str = DEFAULT_RESEARCH_DIR,
    expected_hash: Optional[str] = None,
    validate: bool = True,
) -> Path:
    """Atomically persist `cfg` into `<base_dir>/config.json`.

    Guarantees:
    * Cross-process advisory lock over `.research/.config.lock` around the whole
      read-merge-write, so concurrent writers cannot lose each other's keys.
    * Unknown keys already on disk survive; `cfg` keys (deep-merged) win.
    * Schema validation against `runner.schemas.CONFIG`; failures raise
      `ConfigValidationError` with dotted paths and write nothing. `validate`
      may be disabled only by a caller that has already validated the exact
      dict it is persisting (see `heal_config`).
    * `expected_hash` (full sha256 or a prefix of at least 8 hex chars) raises
      `ConfigStaleError` with a fresh snapshot instead of overwriting; a
      malformed guard raises `ConfigHashError` and writes nothing.
    * Publication is a unique temp file + `os.replace`: a crash between write
      and rename leaves the original file byte-identical.
    """
    if not isinstance(cfg, dict):
        raise ConfigValidationError(
            [
                f"<root>: expected object, got {type(cfg).__name__} "
                "(config must be a JSON object)"
            ]
        )
    guard = normalize_expected_hash(expected_hash)
    target_dir = Path(base_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    cfg_file = target_dir / "config.json"

    with _file_lock(get_lock_path(base_dir)):
        existing_bytes = cfg_file.read_bytes() if cfg_file.is_file() else b""
        current_hash = (
            hashlib.sha256(existing_bytes).hexdigest() if existing_bytes else None
        )
        if guard is not None and not _hash_matches(guard, current_hash):
            fresh = snapshot(base_dir)
            # R5: no absolute workspace path in the stale snapshot payload.
            fresh.pop("path", None)
            fresh["hash"] = current_hash
            fresh["written"] = False
            raise ConfigStaleError(guard, current_hash, fresh)
        on_disk = _read_raw_config(cfg_file)
        merged = merge_config(on_disk or {}, cfg)
        if validate:
            problems = validate_config(merged)
            if problems:
                raise ConfigValidationError(problems)
        _atomic_write_json(cfg_file, merged)
    return cfg_file


# ---------------------------------------------------------------------------
# display
# ---------------------------------------------------------------------------


def display_config(cfg: Dict[str, Any]):
    print("\n⚙️  EPISTEMIC SWARM ACTIVE CONFIGURATION")
    print("========================================")
    print(
        f"  🔍 Primary Search Engine:  {cfg.get('search_engine', 'duckduckgo').upper()}"
    )
    print(f"  🔄 Max Iterations (Depth): {cfg.get('max_iterations', 2)}")
    print(
        f"  ⚖️  Divergence Threshold:  {cfg.get('divergence_threshold', 0.75)} (advisory)"
    )
    print(f"  🎯 Operating Mode:         {cfg.get('mode', 'research').upper()}")
    print(
        f"  🖥️  Agent Backend:         {cfg.get('backend', 'auto').upper()} (auto = host-native)"
    )
    print(
        f"  💾 Raw Markdown Caching:   {'ENABLED' if cfg.get('cache_raw_markdown', True) else 'DISABLED'}"
    )
    print(f"  📜 License Whitelist:      {', '.join(cfg.get('license_whitelist', []))}")
    verify = cfg.get("verify") if isinstance(cfg.get("verify"), dict) else {}
    print(f"  🔬 Min Fuzzy Confidence:   {verify.get('min_fuzzy_confidence', 0.88)}")
    print(
        f"  📁 Output Directory:       {cfg.get('output_dir', '.research')} (deprecated)"
    )
    print("========================================\n")


def run_interactive(cfg: Dict[str, Any]) -> Dict[str, Any]:
    print("\n🔧 Epistemic Swarm Interactive Configuration Setup")
    print("--------------------------------------------------")

    # 1. Search engine
    print("\nSelect Primary Search Engine:")
    print("  1) DuckDuckGo (Zero-key default, free, no limits)")
    print("  2) Brave Search (High accuracy SERP, requires BRAVE_SEARCH_API_KEY)")
    print("  3) Firecrawl (Deep JS rendering, requires FIRECRAWL_API_KEY)")
    print("  4) SearXNG (Self-hosted metasearch aggregator)")
    engine_choice = input(f"Choice [current: {cfg['search_engine']}]: ").strip()
    if engine_choice == "1":
        cfg["search_engine"] = "duckduckgo"
    elif engine_choice == "2":
        cfg["search_engine"] = "brave"
    elif engine_choice == "3":
        cfg["search_engine"] = "firecrawl"
    elif engine_choice == "4":
        cfg["search_engine"] = "searxng"

    # 2. Max iterations
    print("\nSelect Research Depth / Max Iterations:")
    print("  1) 1 Pass  — Rapid brief (low token usage)")
    print("  2) 2 Passes — Standard dialectic thesis vs antithesis (recommended)")
    print("  3) 3 Passes — Deep investigation")
    print("  4) 4 Passes — Exhaustive multi-scope audit")
    depth_choice = input(f"Choice [current: {cfg['max_iterations']}]: ").strip()
    if depth_choice in ("1", "2", "3", "4"):
        cfg["max_iterations"] = int(depth_choice)

    # 3. Operating mode
    print("\nSelect Primary Operating Mode:")
    print("  1) research   — Empirical web & literature synthesis")
    print("  2) audit      — Deep codebase architecture & vulnerability audit")
    print("  3) scout      — Open-source software discovery & clean-room harvesting")
    print("  4) hybrid     — Combined codebase audit + web research")
    print("  5) brainstorm — Lateral creative ideation & what-if exploration")
    print("  6) darkharvest — Product competitor teardown & clean-room harvest")
    mode_choice = input(f"Choice [current: {cfg['mode']}]: ").strip()
    if mode_choice == "1":
        cfg["mode"] = "research"
    elif mode_choice == "2":
        cfg["mode"] = "audit"
    elif mode_choice == "3":
        cfg["mode"] = "scout"
    elif mode_choice == "4":
        cfg["mode"] = "hybrid"
    elif mode_choice == "5":
        cfg["mode"] = "brainstorm"
    elif mode_choice == "6":
        cfg["mode"] = "darkharvest"

    return cfg


def _set_engine(cfg, value):
    if value.lower() in ("duckduckgo", "brave", "firecrawl", "searxng"):
        cfg["search_engine"] = value.lower()
        return True
    return False


def _set_depth(cfg, value):
    try:
        cfg["max_iterations"] = int(value)
        return True
    except ValueError:
        return False


def _set_mode(cfg, value):
    if value.lower() in (
        "research",
        "audit",
        "scout",
        "hybrid",
        "brainstorm",
        "darkharvest",
    ):
        cfg["mode"] = value.lower()
        return True
    return False


def _set_divergence(cfg, value):
    try:
        cfg["divergence_threshold"] = float(value)
        return True
    except ValueError:
        return False


def _set_backend(cfg, value):
    if value.lower() in ("auto", "claude", "opencode"):
        cfg["backend"] = value.lower()
        return True
    return False


# flag spellings -> setter; each setter returns True when it changed config.
_CLI_HANDLERS = [
    (("--engine", "-e"), _set_engine),
    (("--depth", "-d", "--iterations"), _set_depth),
    (("--mode", "-m"), _set_mode),
    (("--divergence",), _set_divergence),
    (("--backend",), _set_backend),
]


def _parse_cli_updates(args: list, cfg: Dict[str, Any]) -> bool:
    modified = False
    idx = 0
    while idx < len(args):
        value = args[idx + 1] if idx + 1 < len(args) else None
        for flags, handler in _CLI_HANDLERS:
            if args[idx] in flags:
                if value is not None and handler(cfg, value):
                    modified = True
                idx += 1
                break
        idx += 1
    return modified


def _save_or_report(cfg: Dict[str, Any]) -> Optional[Path]:
    """Save the CLI-edited config; print a structured error on refusal."""
    try:
        return save_config(cfg)
    except ConfigError as exc:
        sys.stderr.write(f"\n❌ Configuration not saved.\n{exc}\n")
        return None


def main():
    cfg = load_config()
    if heal_config():
        print(
            "ℹ️  Migrated legacy ['claude', '-p'] agent backend pin → host-native default."
        )
    args = sys.argv[1:]

    if not args or "--show" in args:
        display_config(cfg)
        if not args:
            print("To edit settings, run:")
            print("  python3 skills/swarm_config/configure.py --interactive")
            print(
                "  python3 skills/swarm_config/configure.py --engine duckduckgo --depth 3 --mode audit\n"
            )
        return

    if "--interactive" in args or "-i" in args:
        cfg = run_interactive(cfg)
        cfg_path = _save_or_report(cfg)
        if cfg_path is None:
            raise SystemExit(1)
        print(f"✅ Configuration saved to {cfg_path}")
        display_config(cfg)
        return

    modified = _parse_cli_updates(args, cfg)
    if modified:
        cfg_path = _save_or_report(cfg)
        if cfg_path is None:
            raise SystemExit(1)
        print(f"✅ Configuration updated and saved to {cfg_path}")
    display_config(cfg)


if __name__ == "__main__":
    main()
