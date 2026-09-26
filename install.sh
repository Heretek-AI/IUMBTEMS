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
ln -sf "$REPO_DIR/skills/grilling" "$CLAUDE_DIR/skills/grilling"
ln -sf "$REPO_DIR/skills/research-cache" "$CLAUDE_DIR/skills/research-cache"
echo "   - $CLAUDE_DIR/skills/grilling -> $REPO_DIR/skills/grilling"
echo "   - $CLAUDE_DIR/skills/research-cache -> $REPO_DIR/skills/research-cache"

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

echo ""
echo "🎉 Epistemic Swarm installation complete!"
echo "   - Interactive Grilling: run /grilling inside Claude Code"
echo "   - Headless Research Swarm: npx @heretek-ai/epistemic-swarm run \"<objective>\""
echo "========================================================"
