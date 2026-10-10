#!/bin/sh
# idea-from-issue: print the factory idea for one GitHub issue of this repo.
# Usage: idea-from-issue.sh <issue-number>
# (The CLI runs this for `es factory init --preset self-dogfood --issue <n>`.)
set -eu
if [ "$#" -ne 1 ]; then
  echo "Usage: idea-from-issue.sh <issue-number>" >&2
  exit 2
fi
gh issue view "$1" --json number,title,body,url --jq '"#\(.number): \(.title)\n\n\(.url)\n\n\(.body)"'
