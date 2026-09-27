#!/usr/bin/env python3
"""
Interactive Configuration Manager for IUMBTEMS Epistemic Swarm.
Reads, modifies, and persists research parameters in .research/config.json.
"""

import copy
import sys
import os
import json
from pathlib import Path
from typing import Any, Dict

DEFAULT_RESEARCH_DIR = ".research"

DEFAULT_CONFIG: Dict[str, Any] = {
    "search_engine": "duckduckgo",
    "max_iterations": 2,
    "divergence_threshold": 0.75,
    "mode": "research",  # "research", "audit", "scout", "hybrid", "brainstorm", "darkharvest"
    "backend": "auto",  # "auto" (host-native) | "claude" | "opencode"
    "cache_raw_markdown": True,
    "license_whitelist": ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC"],
    "output_dir": DEFAULT_RESEARCH_DIR,
    # Scope allocation policy (Stream F): "dag" = legacy dependency-first
    # order; "auction" = Frontier Markets (highest expected-information-gain
    # bid first). Default "dag" preserves existing behavior exactly.
    "allocation": "dag",
    # Regulated Domain Pack id (Stream G) or null for the legacy constitution.
    # Loaded via runner.refinement.load_domain_pack (config/domain_packs/).
    "domain_pack": None,
    # Per-agent backends. Asymmetry is the point (Stream E): Alpha and Beta on
    # different model families/weights probe divergence that prompt-level
    # red-teaming cannot reach. `backend` is a command list, not just a model
    # string, because cross-FAMILY means non-Claude processes.
    # None means "fall through to the host-native default" (claude -p on
    # Claude Code, opencode run on OpenCode) — explicit values still win.
    # mock mode never builds or spawns these commands.
    "agents": {
        "alpha": {"backend": None, "model": None},
        "beta": {"backend": None, "model": None},
    },
}


# Historical pre-0.7.6 default that was persisted verbatim into user configs.
# A per-role pin equal to this value, while the top-level `backend` is not an
# explicit "claude", is a stale default rather than a deliberate choice: it must
# not override the host-native backend (opencode on OpenCode). Explicit intent
# lives in `backend: "claude"` or `IUMBTEMS_BACKEND_<ROLE>`.
LEGACY_AGENT_BACKEND_PINS = (["claude", "-p"],)

AGENT_ROLES = ("alpha", "beta")


def get_config_path(base_dir: str = DEFAULT_RESEARCH_DIR) -> Path:
    return Path(base_dir) / "config.json"


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
    migrate_legacy_agent_backends(merged)
    return merged


def heal_config(base_dir: str = DEFAULT_RESEARCH_DIR) -> bool:
    """Persist a legacy agent-backend migration to disk; True if rewritten.

    `load_config` stays side-effect free; the CLI and MCP surfaces call this so
    an affected install self-heals instead of re-pinning Claude on every save.
    """
    cfg_file = get_config_path(base_dir)
    if not cfg_file.exists():
        return False
    try:
        with open(cfg_file, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except Exception:
        return False
    if not isinstance(raw, dict):
        return False
    if not migrate_legacy_agent_backends(raw):
        return False
    save_config(load_config(base_dir), base_dir)
    return True


def save_config(cfg: Dict[str, Any], base_dir: str = DEFAULT_RESEARCH_DIR) -> Path:
    target_dir = Path(base_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    cfg_file = target_dir / "config.json"
    with open(cfg_file, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    return cfg_file


def display_config(cfg: Dict[str, Any]):
    print("\n⚙️  EPISTEMIC SWARM ACTIVE CONFIGURATION")
    print("========================================")
    print(
        f"  🔍 Primary Search Engine:  {cfg.get('search_engine', 'duckduckgo').upper()}"
    )
    print(f"  🔄 Max Iterations (Depth): {cfg.get('max_iterations', 2)}")
    print(f"  ⚖️  Divergence Threshold:  {cfg.get('divergence_threshold', 0.75)}")
    print(f"  🎯 Operating Mode:         {cfg.get('mode', 'research').upper()}")
    print(
        f"  🖥️  Agent Backend:         {cfg.get('backend', 'auto').upper()} (auto = host-native)"
    )
    print(
        f"  💾 Raw Markdown Caching:   {'ENABLED' if cfg.get('cache_raw_markdown', True) else 'DISABLED'}"
    )
    print(f"  📜 License Whitelist:      {', '.join(cfg.get('license_whitelist', []))}")
    print(f"  📁 Output Directory:       {cfg.get('output_dir', '.research')}")
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
        cfg_path = save_config(cfg)
        print(f"✅ Configuration saved to {cfg_path}")
        display_config(cfg)
        return

    modified = _parse_cli_updates(args, cfg)
    if modified:
        cfg_path = save_config(cfg)
        print(f"✅ Configuration updated and saved to {cfg_path}")
    display_config(cfg)


if __name__ == "__main__":
    main()
