#!/usr/bin/env bash
# Build, pack and install the publishable packages the way users get them,
# then run them: the CLI under Node, the OpenCode plugin's server entry under
# Bun. `bun pm pack` rewrites workspace:* to real versions; this fails if any
# manifest still carries it, or if the installed CLI cannot find core's
# bundled assets (prompts, skills, licence templates).
#
# Usage: scripts/pack-smoke.sh [out-dir]   (tarballs are left in out-dir)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$(mktemp -d)}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
# The release packages and their tarball slugs, in publish order, from the
# single source of truth (scripts/packages.ts reads packages/*/package.json).
release="$(bun "$root/scripts/packages.ts" --release)"
# Drop tarballs from previous runs: a stale same-name version would shadow the
# fresh pack when npm resolves the workspace dependencies between tarballs.
while read -r pkg slug; do rm -f "$out"/${slug}-*.tgz; done <<< "$release"

# Build every release package from the same single source of truth (no hand
# list to drift): each manifest's `build` script knows how (`tsc -b` for core,
# `bun build` for the CLI; the TUI entry ships pre-compiled because the host
# Solid transform skips node_modules, where npm-installed plugins live, so
# raw .tsx would fall back to react-jsx and fail on 'react' at load).
while read -r pkg slug; do
  (cd "$root/packages/$pkg" && rm -rf dist tsconfig.tsbuildinfo && bun run build >/dev/null)
done <<< "$release"
while read -r pkg slug; do
  (cd "$root/packages/$pkg" && bun pm pack --destination "$out" >/dev/null)
done <<< "$release"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"
npm init -y >/dev/null
npm install --ignore-scripts --no-audit --no-fund \
  $(while read -r pkg slug; do echo "$out"/${slug}-*.tgz; done <<< "$release") >/dev/null

if grep -l '"workspace:' node_modules/@heretek-ai/*/package.json; then
  echo "pack-smoke: a workspace: protocol leaked into a packed manifest" >&2
  exit 1
fi

mkdir -p proj/cand
cp "$root/packages/core/test/fixtures/licenses/MIT.txt" proj/cand/LICENSE
echo 'export const a = 1' >proj/cand/a.ts
git -C proj init -q

node node_modules/.bin/es --help >/dev/null
node node_modules/.bin/es --cwd proj harvest scan local:cand | grep -q "License: MIT (permissive, license-file, verified)"
node --input-type=module -e '
  const core = await import("@heretek-ai/es-core")
  await core.loadPrompt("factory")
  if ((await core.loadSkills()).length < 1) process.exit(1)'
bun -e '
  const plugin = await import("@heretek-ai/epistemic-swarm/server")
  if (plugin.default?.id !== "epistemic-swarm") process.exit(1)'

echo "pack-smoke: ok ($(node --version), tarballs in $out)"
