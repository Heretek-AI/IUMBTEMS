#!/usr/bin/env bash
# Run the real-host suite against OpenCode v2 HEAD (the nightly job, or
# locally). Clones/fetches the v2 branch, installs it, points the published
# @opencode packages at the checkout for this run, and runs the given tests.
#
#   scripts/v2-head.sh                       # bun test packages/opencode
#   scripts/v2-head.sh packages/opencode packages/testkit
#
# This repoints node_modules symlinks; `bun install` restores them.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
head_dir="${V2_HEAD_DIR:-${RUNNER_TEMP:-/tmp}/opencode-v2-head}"
branch="${V2_HEAD_BRANCH:-v2}"
repo="${V2_HEAD_REPO:-https://github.com/anomalyco/opencode.git}"

if [ -d "$head_dir/.git" ]; then
  git -C "$head_dir" fetch --depth 1 origin "$branch"
  git -C "$head_dir" reset --hard FETCH_HEAD
else
  rm -rf "$head_dir"
  git clone --depth 1 --branch "$branch" "$repo" "$head_dir"
fi
echo "v2 HEAD: $(git -C "$head_dir" log -1 --format='%h %ci')"
(cd "$head_dir" && bun install)

for target in "$root"/packages/*/node_modules/@opencode/sdk "$root"/packages/*/node_modules/@opencode/plugin; do
  [ -e "$target" ] || [ -L "$target" ] || continue
  name="$(basename "$target")"
  rm -rf "$target"
  ln -s "$head_dir/packages/$name" "$target"
done

cd "$root"
if [ "$#" -gt 0 ]; then
  exec bun test "$@"
fi
exec bun test packages/opencode
