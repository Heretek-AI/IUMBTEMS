#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
CLAUDE_JSON="$HOME/.claude.json"

echo "========================================================"
echo "🚀 Installing Epistemic Swarm into Claude Code"
echo "   Source: $REPO_DIR"
echo "========================================================"

# 1. Dependency checks
command -v python3 >/dev/null 2>&1 || { echo "❌ python3 is required but not installed."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "❌ node is required but not installed."; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "❌ npm is required but not installed."; exit 1; }

echo "✅ Core prerequisites detected (Python $(python3 --version | cut -d' ' -f2), Node $(node -v))"

# 2. Setup ~/.claude/skills symlinks
mkdir -p "$CLAUDE_DIR/skills"

echo "🔗 Linking skills into $CLAUDE_DIR/skills/..."
for skill in grilling research_cache epistemic_search swarm_config code_audit oss_scout brainstorming darkharvest factory; do
  # legacy research-cache dir name kept as alias for older configs
  ln -sfn "$REPO_DIR/skills/$skill" "$CLAUDE_DIR/skills/$skill"
  echo "   - $CLAUDE_DIR/skills/$skill -> $REPO_DIR/skills/$skill"
done
if [[ ! -e "$CLAUDE_DIR/skills/research-cache" ]]; then
  ln -sfn "$REPO_DIR/skills/research_cache" "$CLAUDE_DIR/skills/research-cache"
  echo "   - $CLAUDE_DIR/skills/research-cache -> $REPO_DIR/skills/research_cache (legacy alias)"
fi

# 3. Patch ~/.claude.json mcpServers non-destructively
if [[ -f "$CLAUDE_JSON" ]]; then
    echo "🔧 Merging research MCP servers into $CLAUDE_JSON..."
    python3 - <<EOF
import json
from pathlib import Path

claude_json_path = Path("$CLAUDE_JSON")
mcp_config_path = Path("$REPO_DIR/config/mcp-research-servers.json")

try:
    with open(claude_json_path, 'r', encoding='utf-8') as f:
        claude_data = json.load(f)
    
    with open(mcp_config_path, 'r', encoding='utf-8') as f:
        mcp_data = json.load(f)

    if "mcpServers" not in claude_data:
        claude_data["mcpServers"] = {}

    for server_name, server_def in mcp_data.get("mcpServers", {}).items():
        # The first-party iumbtems server must resolve absolutely: a relative
        # "runner/mcp_server.py" only works when cwd is the repo root.
        if server_name == "iumbtems":
            server_def = dict(server_def)
            server_def["args"] = [str(Path("$REPO_DIR") / "runner" / "mcp_server.py")]
            env = dict(server_def.get("env") or {})
            env["PYTHONPATH"] = "$REPO_DIR"
            server_def["env"] = env

        if server_name not in claude_data["mcpServers"]:
            claude_data["mcpServers"][server_name] = server_def
            print(f"   + Added MCP server: {server_name}")
        else:
            print(f"   ℹ️ MCP server already configured: {server_name}")

    with open(claude_json_path, 'w', encoding='utf-8') as f:
        json.dump(claude_data, f, indent=2)
    print("✅ ~/.claude.json successfully updated.")
except Exception as e:
    print(f"⚠️ Non-critical warning merging MCP servers: {e}")
EOF
fi

# 4. Patch ~/.claude/settings.json
SETTINGS_JSON="$CLAUDE_DIR/settings.json"
if [[ -f "$SETTINGS_JSON" ]]; then
    echo "🔧 Merging plugin settings into $SETTINGS_JSON..."
    python3 - <<EOF
import json
from pathlib import Path

settings_path = Path("$SETTINGS_JSON")
try:
    with open(settings_path, 'r', encoding='utf-8') as f:
        settings = json.load(f)

    if "env" not in settings:
        settings["env"] = {}

    defaults = {
        "SEARXNG_URL": "http://localhost:8080",
        "FIRECRAWL_API_URL": "http://localhost:3002"
    }

    for k, v in defaults.items():
        if k not in settings["env"]:
            settings["env"][k] = v
            print(f"   + Added environment default: {k}={v}")

    with open(settings_path, 'w', encoding='utf-8') as f:
        json.dump(settings, f, indent=2)
    print("✅ ~/.claude/settings.json successfully updated.")
except Exception as e:
    print(f"⚠️ Non-critical warning updating settings: {e}")
EOF
fi

# 5. OpenCode V2 integration (plugins/agents/skills/mcp.servers — merge only)
OPENCODE_JSON="$HOME/.config/opencode/opencode.json"
echo "🔧 Merging OpenCode V2 configuration into $OPENCODE_JSON..."
python3 - <<EOF
import json
from pathlib import Path

repo = Path("$REPO_DIR")
oc_path = Path("$OPENCODE_JSON")
PKG = "@heretek-ai/epistemic-swarm"
OPTION_KEYS = {"search_engine", "max_iterations", "mode", "divergence_threshold"}

oc_path.parent.mkdir(parents=True, exist_ok=True)
cfg = json.loads(oc_path.read_text(encoding="utf-8")) if oc_path.exists() else {}

# --- plugins (V2): object form {"package", "options"}; migrate legacy `plugin` ---
plugins = cfg.get("plugins")
if not isinstance(plugins, list):
    plugins = []

# Migrate any legacy V1 `plugin` entries: bare strings, [pkg, options] tuples,
# and the "wild" malformation where a bare options object trails our package.
legacy = cfg.get("plugin")
if isinstance(legacy, list):
    i = 0
    while i < len(legacy):
        item = legacy[i]
        if isinstance(item, str):
            if item == PKG and i + 1 < len(legacy) and isinstance(legacy[i + 1], dict) and (set(legacy[i + 1]) & OPTION_KEYS):
                plugins.append({"package": PKG, "options": legacy[i + 1]})
                i += 2
                continue
            plugins.append(item)
        elif isinstance(item, list) and item:
            opts = item[1] if len(item) > 1 and isinstance(item[1], dict) else {}
            plugins.append({"package": item[0], "options": opts})
        elif isinstance(item, dict):
            if "package" in item:
                plugins.append(item)
            elif set(item) & OPTION_KEYS:
                plugins.append({"package": PKG, "options": item})
            else:
                plugins.append(item)
        i += 1
    cfg.pop("plugin", None)
    print("   ~ Migrated legacy 'plugin' entries to V2 'plugins' (object form)")

# Normalize our entry to the V2 object form and ensure default options exist.
DEFAULT_OPTIONS = {"search_engine": "duckduckgo", "max_iterations": 2, "mode": "research"}
our = None
for idx, entry in enumerate(plugins):
    if entry == PKG:
        our = {"package": PKG, "options": {}}
        plugins[idx] = our
    elif isinstance(entry, dict) and entry.get("package") == PKG:
        our = entry
        entry["options"] = {**DEFAULT_OPTIONS, **(entry.get("options") or {})}
if our is None:
    our = {"package": PKG, "options": dict(DEFAULT_OPTIONS)}
    plugins.append(our)
    print(f"   + Added plugin entry: {PKG}")
else:
    print(f"   ℹ️ Plugin entry already configured: {PKG}")
cfg["plugins"] = plugins

# --- agents (V2 plural): merge snippet definitions, never overwrite users ---
try:
    snippet = json.loads((repo / "config" / "opencode-snippet.json").read_text(encoding="utf-8"))
    agents = cfg.setdefault("agents", {})
    legacy_agents = cfg.get("agent")
    if isinstance(legacy_agents, dict):
        for name, definition in legacy_agents.items():
            agents.setdefault(name, definition)
        cfg.pop("agent", None)
        print("   ~ Migrated legacy 'agent' entries to V2 'agents'")
    for name, definition in (snippet.get("agents") or snippet.get("agent") or {}).items():
        if name not in agents:
            agents[name] = definition
            print(f"   + Added agent: {name}")
        else:
            print(f"   ℹ️ Agent already configured: {name}")

    # Skills: V2 is a list of directories/URLs. Snippet paths are repo-relative
    # ("./skills/x") which breaks from ~/.config — merge as absolute paths and
    # repair a legacy `{"paths": [...]}` object or relative entries in place.
    import os as _os
    wanted = []
    for sp in snippet.get("skills") or []:
        wanted.append(sp if _os.path.isabs(sp) else str(repo / sp.lstrip("./")))
    skills = cfg.get("skills")
    if isinstance(skills, dict):
        skills = cfg["skills"] = list(skills.get("paths") or [])
        print("   ~ Migrated legacy skills.paths to the V2 skills list")
    elif not isinstance(skills, list):
        skills = cfg["skills"] = []
    for i, existing in enumerate(list(skills)):
        if existing in wanted:
            continue
        for abs_sp in wanted:
            rel = "./" + str(Path(abs_sp).relative_to(repo)) if str(abs_sp).startswith(str(repo)) else None
            if rel and existing == rel:
                skills[i] = abs_sp
                print(f"   ~ Repaired relative skill path: {rel} -> {abs_sp}")
                break
    for abs_sp in wanted:
        if abs_sp not in skills:
            skills.append(abs_sp)
            print(f"   + Added skill path: {abs_sp}")
        else:
            print(f"   ℹ️ Skill path already configured: {abs_sp}")
except Exception as e:
    print(f"   ⚠️ Non-critical warning merging agents: {e}")

# --- MCP server (V2 `mcp.servers`): absolute runner path ---
mcp = cfg.setdefault("mcp", {})
servers = mcp.setdefault("servers", {})
legacy_mcp = mcp.get("iumbtems")
if isinstance(legacy_mcp, dict):
    servers.setdefault("iumbtems", legacy_mcp)
    mcp.pop("iumbtems", None)
    print("   ~ Migrated legacy mcp.iumbtems to V2 mcp.servers.iumbtems")
if "iumbtems" not in servers:
    servers["iumbtems"] = {
        "type": "local",
        "command": ["python3", str(repo / "runner" / "mcp_server.py")],
        "enabled": True,
    }
    print("   + Added MCP server: iumbtems")
else:
    print("   ℹ️ MCP server already configured: iumbtems")

oc_path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
print("✅ OpenCode configuration updated.")
EOF

echo ""
echo "🎉 Epistemic Swarm installation complete!"
echo "   - Interactive Grilling: run /grilling inside Claude Code"
echo "   - Lateral Brainstorming: run /brainstorming inside Claude Code (skills/brainstorming)"
echo "   - OpenCode V2: /swarm /grill /audit /scout /brainstorming via plugin commands"
echo "   - Rebuild harness adapters: python3 scripts/build_adapters.py"
echo "   - Headless Research Swarm: npx @heretek-ai/epistemic-swarm run \"<objective>\""
echo "========================================================"
