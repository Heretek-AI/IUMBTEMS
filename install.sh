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
for skill in grilling research_cache epistemic_search swarm_config code_audit oss_scout brainstorming; do
  # legacy research-cache dir name kept as alias for older configs
  ln -sf "$REPO_DIR/skills/$skill" "$CLAUDE_DIR/skills/$skill"
  echo "   - $CLAUDE_DIR/skills/$skill -> $REPO_DIR/skills/$skill"
done
if [ ! -e "$CLAUDE_DIR/skills/research-cache" ]; then
  ln -sf "$REPO_DIR/skills/research_cache" "$CLAUDE_DIR/skills/research-cache"
  echo "   - $CLAUDE_DIR/skills/research-cache -> $REPO_DIR/skills/research_cache (legacy alias)"
fi

# 3. Patch ~/.claude.json mcpServers non-destructively
if [ -f "$CLAUDE_JSON" ]; then
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
if [ -f "$SETTINGS_JSON" ]; then
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

# 5. OpenCode V2 integration (plugin tuple, agents, MCP server — merge only)
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

# --- plugin entry: tuple form [package, options]; repair bare-object form ---
plugins = cfg.get("plugin", [])
if not isinstance(plugins, list):
    print("   ⚠️ 'plugin' is not a list; leaving untouched")
    plugins = cfg.get("plugin", [])
else:
    repaired = []
    i = 0
    changed = False
    while i < len(plugins):
        item = plugins[i]
        # Bare options object following our package string (or standalone):
        # fold into a tuple instead of leaving an invalid entry.
        if isinstance(item, dict) and set(item) & OPTION_KEYS:
            prev_is_pkg = repaired and repaired[-1] == PKG
            prev_is_tuple = (
                repaired and isinstance(repaired[-1], list)
                and repaired[-1] and repaired[-1][0] == PKG
            )
            if prev_is_pkg:
                repaired[-1] = [PKG, item]
                changed = True
                print("   ~ Repaired bare options object into tuple entry")
            elif prev_is_tuple:
                merged = {**(repaired[-1][1] if len(repaired[-1]) > 1 else {}), **item}
                repaired[-1] = [PKG, merged]
                changed = True
                print("   ~ Folded stray options into existing tuple entry")
            else:
                repaired.append([PKG, item])
                changed = True
                print("   ~ Attached stray options object to new tuple entry")
        else:
            repaired.append(item)
        i += 1
    if not any((p == PKG or (isinstance(p, list) and p and p[0] == PKG)) for p in repaired):
        repaired.append([PKG, {"search_engine": "duckduckgo", "max_iterations": 2, "mode": "research"}])
        changed = True
        print(f"   + Added plugin entry: {PKG}")
    else:
        print(f"   ℹ️ Plugin entry already configured: {PKG}")
    cfg["plugin"] = repaired

# --- agents: merge snippet definitions, never overwrite user agents ---
try:
    snippet = json.loads((repo / "config" / "opencode-snippet.json").read_text(encoding="utf-8"))
    agents = cfg.setdefault("agent", {})
    for name, definition in snippet.get("agent", {}).items():
        if name not in agents:
            agents[name] = definition
            print(f"   + Added agent: {name}")
        else:
            print(f"   ℹ️ Agent already configured: {name}")
except Exception as e:
    print(f"   ⚠️ Non-critical warning merging agents: {e}")

# --- MCP server: absolute runner path (relative paths only work at repo root) ---
mcp = cfg.setdefault("mcp", {})
if "iumbtems" not in mcp:
    mcp["iumbtems"] = {
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
