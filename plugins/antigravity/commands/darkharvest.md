---
description: Product competitor teardown with per-feature harvest verdicts
---

Run a product competitor teardown for `$1`:

`python3 runner/research_swarm.py --mode darkharvest --objective "$1"`

Seeds may be embedded as repo URLs; cap live runs at `--max-repos 6`.
Permissive-only vendor; GPL/AGPL clean-room-rebuild only; workflows clonable, assets never.
Report: `.research/darkharvest_report.md` (matrix + white-space gaps + SPDX backlog).
