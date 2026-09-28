#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
CLAUDE_JSON="$HOME/.claude.json"

# Opt-in cost gate. With --search-gate we add ONE rule to the user's OpenCode
# config: {action:"websearch", resource:"*", effect:"ask"}. The websearch
# permission action uses the search query as the resource
# [VERIFIED: 8bde98f3962fef9407abc4622660d9f52f0490de803151fcc0ce0f648f7c0bbe],
# so every billable search prompts. Without the flag install.sh never touches
# the permissions array. Manual equivalent (opencode.json):
#   { "$schema": "https://opencode.ai/config.json",
#     "permissions": [ { "action": "websearch", "resource": "*", "effect": "ask" } ] }
SEARCH_GATE=0

usage() {
  cat <<'USAGE'
Usage: install.sh [--search-gate]

  --search-gate   Add {"action":"websearch","resource":"*","effect":"ask"} to the
                  OpenCode config permissions so every search prompts before it
                  can incur cost. Opt-in only; without it permissions are untouched.
  -h, --help      Show this help.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --search-gate) SEARCH_GATE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "❌ Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

echo "========================================================"
echo "🚀 Installing Epistemic Swarm into Claude Code"
echo "   Source: $REPO_DIR"
[[ "$SEARCH_GATE" == "1" ]] && echo "   Search cost gate: ON (websearch -> ask)"
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
    # Heredoc is QUOTED (<<'PY'): an unquoted heredoc runs command substitution
    # on backticks in comments (e.g. "permissions") and breaks the install.
    # Variables are passed through the environment instead.
    CLAUDE_JSON="$CLAUDE_JSON" REPO_DIR="$REPO_DIR" python3 - <<'PY'
import json
import os
from pathlib import Path

claude_json_path = Path(os.environ["CLAUDE_JSON"])
repo_dir = os.environ["REPO_DIR"]
mcp_config_path = Path(repo_dir) / "config" / "mcp-research-servers.json"

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
            server_def["args"] = [str(Path(repo_dir) / "runner" / "mcp_server.py")]
            env = dict(server_def.get("env") or {})
            env["PYTHONPATH"] = repo_dir
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
PY
fi

# 4. Patch ~/.claude/settings.json
SETTINGS_JSON="$CLAUDE_DIR/settings.json"
if [[ -f "$SETTINGS_JSON" ]]; then
    echo "🔧 Merging plugin settings into $SETTINGS_JSON..."
    # Quoted heredoc: keep shell expansion out of the Python (see note above).
    SETTINGS_JSON="$SETTINGS_JSON" python3 - <<'PY'
import json
import os
from pathlib import Path

settings_path = Path(os.environ["SETTINGS_JSON"])
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
PY
fi

# 5. OpenCode V2 integration (plugins/agents/skills/mcp.servers — merge only)
OPENCODE_JSON="$HOME/.config/opencode/opencode.json"
echo "🔧 Merging OpenCode V2 configuration into $OPENCODE_JSON..."
# Quoted heredoc (<<'PY'): the comment text below contains backticks, which an
# unquoted heredoc would execute as command substitution ("permissions: command
# not found", "plugin: command not found", …). Variables go via the environment.
REPO_DIR="$REPO_DIR" OPENCODE_JSON="$OPENCODE_JSON" SEARCH_GATE="$SEARCH_GATE" python3 - <<'PY'
import json
import os
from pathlib import Path

repo = Path(os.environ["REPO_DIR"])
oc_path = Path(os.environ["OPENCODE_JSON"])
search_gate = os.environ.get("SEARCH_GATE", "0")
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

if search_gate == "1":
    # Opt-in cost gate. V2 config key is `permissions` (a list of rules); the
    # websearch action's resource is the search query, so "*" gates them all.
    rules = cfg.get("permissions")
    if rules is not None and not isinstance(rules, list):
        # A non-list shape is not a V2 permissions list. Refuse LOUDLY rather
        # than replacing it with a fresh list and silently dropping unrelated
        # entries.
        raise SystemExit(
            "❌ opencode.json `permissions` is a "
            f"{type(rules).__name__}, not a list; refusing to overwrite it. "
            "Convert it to a list of {action, resource, effect} rules, then "
            "re-run install.sh --search-gate."
        )
    if not isinstance(rules, list):
        rules = cfg["permissions"] = []

    def _is_websearch(rule):
        return isinstance(rule, dict) and rule.get("action") == "websearch"

    # --- Safety: NEVER downgrade an explicit deny. An existing websearch
    # `deny` is stricter than the `ask` gate, so adding ask would weaken it.
    # Preserve the config untouched and refuse loudly instead of silently
    # rewriting a security decision the user made.
    websearch_denies = [
        r for r in rules if _is_websearch(r) and r.get("effect") == "deny"
    ]
    if websearch_denies:
        raise SystemExit(
            "❌ opencode.json already denies websearch "
            f"({json.dumps(websearch_denies)}); the --search-gate `ask` rule "
            "would be WEAKER than it, so install.sh refuses to downgrade it and "
            "leaves your config untouched.\n"
            "   The existing deny is already stricter than ask. If you really "
            "want the ask gate instead, remove the websearch deny rule(s) "
            "manually, then re-run `install.sh --search-gate`."
        )

    canonical = {"action": "websearch", "resource": "*", "effect": "ask"}
    global_ws = [
        r for r in rules if _is_websearch(r) and r.get("resource") == "*"
    ]
    # Resource-scoped websearch rules (resource != "*") are the user's explicit
    # per-query decisions. NEVER silently drop them: keep every one and report
    # it, so a scoped `allow` that out-ranks the gate is visible rather than
    # quietly deleted.
    scoped_ws = [
        r for r in rules if _is_websearch(r) and r.get("resource") != "*"
    ]
    for rule in scoped_ws:
        if rule.get("effect") == "allow":
            print(
                "   ⚠️ Preserved resource-scoped websearch allow "
                f"({json.dumps(rule)}): a specific resource rule out-ranks the "
                "'*' ask gate, so the gate will NOT prompt for queries it "
                "matches."
            )
        else:
            print(
                "   ℹ️ Preserved existing websearch rule "
                f"({json.dumps(rule)})"
            )

    if global_ws:
        # Collapse every resource-"*" websearch rule into the single canonical
        # ask gate. Only allow|ask effects can reach here (a deny aborts above).
        # Report every replacement/drop instead of mutating silently.
        replaced = []
        for rule in global_ws:
            effect = rule.get("effect")
            if effect == "allow":
                replaced.append("replaced websearch allow (*) with ask")
            elif effect != "ask":
                replaced.append(
                    f"replaced websearch effect={effect!r} (*) with ask"
                )
        duplicates = len(global_ws) - 1
        rules[:] = [
            r for r in rules if not (_is_websearch(r) and r.get("resource") == "*")
        ]
        rules.append(canonical)
        for note in replaced:
            print(f"   ~ {note}")
        if duplicates > 0:
            print(
                f"   ~ Dropped {duplicates} duplicate websearch '*' rule(s)"
            )
        if not replaced and duplicates == 0:
            print("   ℹ️ websearch ask-gate permission already configured")
    else:
        rules.append(canonical)
        print("   + Added websearch ask-gate permission (--search-gate)")
else:
    print("   ℹ️ permissions untouched (pass --search-gate to add the websearch ask rule)")

oc_path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
print("✅ OpenCode configuration updated.")
PY

echo ""
echo "🎉 Epistemic Swarm installation complete!"
echo "   - Interactive Grilling: run /grilling inside Claude Code"
echo "   - Lateral Brainstorming: run /brainstorming inside Claude Code (skills/brainstorming)"
echo "   - OpenCode V2: /swarm /grill /audit /scout /brainstorming via plugin commands"
echo "   - Cost gate (opt-in): re-run with --search-gate to add a websearch ask rule"
echo "   - Rebuild harness adapters: python3 scripts/build_adapters.py"
echo "   - Headless Research Swarm: npx @heretek-ai/epistemic-swarm run \"<objective>\""
echo "========================================================"
