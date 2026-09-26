#!/usr/bin/env python3
"""
Interactive Configuration Manager for IUMBTEMS Epistemic Swarm.
Reads, modifies, and persists research parameters in .research/config.json.
"""

import sys
import os
import json
from pathlib import Path
from typing import Dict, Any

DEFAULT_CONFIG: Dict[str, Any] = {
    "search_engine": "duckduckgo",
    "max_iterations": 2,
    "divergence_threshold": 0.75,
    "mode": "research",  # "research", "audit", "scout", "hybrid"
    "cache_raw_markdown": True,
    "license_whitelist": ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC"],
    "output_dir": ".research"
}

def get_config_path(base_dir: str = ".research") -> Path:
    return Path(base_dir) / "config.json"

def load_config(base_dir: str = ".research") -> Dict[str, Any]:
    cfg_file = get_config_path(base_dir)
    if not cfg_file.exists():
        return dict(DEFAULT_CONFIG)
    try:
        with open(cfg_file, "r", encoding="utf-8") as f:
            data = json.load(f)
            merged = dict(DEFAULT_CONFIG)
            merged.update(data)
            return merged
    except Exception as e:
        sys.stderr.write(f"[swarm-config] Warning: Failed to parse {cfg_file}: {e}. Using defaults.\n")
        return dict(DEFAULT_CONFIG)

def save_config(cfg: Dict[str, Any], base_dir: str = ".research") -> Path:
    target_dir = Path(base_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    cfg_file = target_dir / "config.json"
    with open(cfg_file, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    return cfg_file

def display_config(cfg: Dict[str, Any]):
    print("\n⚙️  EPISTEMIC SWARM ACTIVE CONFIGURATION")
    print("========================================")
    print(f"  🔍 Primary Search Engine:  {cfg.get('search_engine', 'duckduckgo').upper()}")
    print(f"  🔄 Max Iterations (Depth): {cfg.get('max_iterations', 2)}")
    print(f"  ⚖️  Divergence Threshold:  {cfg.get('divergence_threshold', 0.75)}")
    print(f"  🎯 Operating Mode:         {cfg.get('mode', 'research').upper()}")
    print(f"  💾 Raw Markdown Caching:   {'ENABLED' if cfg.get('cache_raw_markdown', True) else 'DISABLED'}")
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
    print("  1) research — Empirical web & literature synthesis")
    print("  2) audit    — Deep codebase architecture & vulnerability audit")
    print("  3) scout    — Open-source software discovery & clean-room harvesting")
    print("  4) hybrid   — Combined codebase audit + web research")
    mode_choice = input(f"Choice [current: {cfg['mode']}]: ").strip()
    if mode_choice == "1":
        cfg["mode"] = "research"
    elif mode_choice == "2":
        cfg["mode"] = "audit"
    elif mode_choice == "3":
        cfg["mode"] = "scout"
    elif mode_choice == "4":
        cfg["mode"] = "hybrid"

    return cfg

def main():
    cfg = load_config()
    args = sys.argv[1:]

    if not args or "--show" in args:
        display_config(cfg)
        if not args:
            print("To edit settings, run:")
            print("  python3 skills/swarm_config/configure.py --interactive")
            print("  python3 skills/swarm_config/configure.py --engine duckduckgo --depth 3 --mode audit\n")
        return

    if "--interactive" in args or "-i" in args:
        cfg = run_interactive(cfg)
        cfg_path = save_config(cfg)
        print(f"✅ Configuration saved to {cfg_path}")
        display_config(cfg)
        return

    idx = 0
    modified = False
    while idx < len(args):
        arg = args[idx]
        if arg in ("--engine", "-e") and idx + 1 < len(args):
            engine = args[idx + 1].lower()
            if engine in ("duckduckgo", "brave", "firecrawl", "searxng"):
                cfg["search_engine"] = engine
                modified = True
            idx += 1
        elif arg in ("--depth", "-d", "--iterations") and idx + 1 < len(args):
            try:
                cfg["max_iterations"] = int(args[idx + 1])
                modified = True
            except ValueError:
                pass
            idx += 1
        elif arg in ("--mode", "-m") and idx + 1 < len(args):
            mode = args[idx + 1].lower()
            if mode in ("research", "audit", "scout", "hybrid"):
                cfg["mode"] = mode
                modified = True
            idx += 1
        elif arg == "--divergence" and idx + 1 < len(args):
            try:
                cfg["divergence_threshold"] = float(args[idx + 1])
                modified = True
            except ValueError:
                pass
            idx += 1
        idx += 1

    if modified:
        cfg_path = save_config(cfg)
        print(f"✅ Configuration updated and saved to {cfg_path}")
        display_config(cfg)
    else:
        display_config(cfg)

if __name__ == "__main__":
    main()
