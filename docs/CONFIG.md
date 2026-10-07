# Config

The canonical Epistemic Swarm config (`packages/core/src/schema/config.ts`), layered:
user-global (`~/.config/epistemic-swarm/config.json`) → project (`.factory/config.json`) →
plugin options in `opencode.json`. Unknown keys are rejected. Generated: do not edit by hand.

| field | type | default | description |
| --- | --- | --- | --- |
| `models` | object | — | Abstract model tiers mapped to concrete provider/model ids; unset tiers inherit the session default. |
| `afterEdit` | string (fast, off) | `"fast"` | Gates after each programmer edit: fast built-ins or off (the phase-end gates always run). |
| `estimate` | object | — | Spend estimates used when the host reports no cost; estimates are labelled as such. |
| `pr` | string (gh, off) | `"gh"` | Release PR opener: the GitHub CLI, or off. |
| `lspAfterEdit` | boolean | `true` | Append language-server diagnostics to edit results. |
| `searchProvider` | string (brave, firecrawl, searxng) | — | Web search provider; the default is the first one with credentials. |
| `licenseWhitelist` | array | `["MIT","Apache-2.0","BSD-2-Clause","BSD-3-Clause","ISC","0BSD","Unlicense","CC0-1.0"]` | SPDX ids darkharvest may depend on or vendor; everything else is clean-room only. |

`es config show` and `/config` print the effective config and which files contributed.
