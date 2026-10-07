---
name: harvest
description: Competitor teardown with fail-closed SPDX detection, per-field provenance, a policy-enforced feature matrix, clean-room specs and a vendor plan.
---
# Darkharvest

Product-level teardown of competitor or inspiration projects: what they do, what they are licensed under, what can be depended on, vendored, clean-room rebuilt or skipped.

## When to use
- The human runs `/harvest` or asks "how does X do this / what can we take from Y".
- Before a grill, to check prior art and licence obligations.

## The flow (mechanical where it counts)
1. `es_harvest_plan` — objective, candidates, read budget, licence whitelist.
2. `es_harvest_discover` — GitHub/GitLab search by query, topic or dependency overlap; the LLM reranks, the human edits the list.
3. `es_harvest_scan` — shallow clone (or local read), tree-sitter structural index, deterministic SPDX detection. Unverified/unknown/copyleft licences are recorded as such and can only end up clean-room.
4. `es_harvest_read` — bounded content reads inside the token budget.
5. `es_harvest_matrix` — per-feature verdicts; the policy rewrites anything it cannot authorise and attaches SPDX attribution to what it can.
6. `es_harvest_complete` — `HARVEST.md`, `VENDOR-PLAN.md`, clean-room specs.

## Outputs
`.factory/harvest/<candidate>/profile.json` (per-field provenance), `matrix.json`, `harvest.json`, `HARVEST.md`, `VENDOR-PLAN.md`, `clean-room/*.md`.

## Rules
- Fail closed on licences: no LICENSE bytes or SPDX header means no depend/vendor, ever.
- Never copy upstream code, prose or assets; workflows may inform behaviour, not source.
- A failed network check marks its claim UNVERIFIED and blocks downstream use of it.
