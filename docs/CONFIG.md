# Config

The canonical Epistemic Swarm config (`packages/core/src/schema/config.ts`), layered:
user-global (`~/.config/epistemic-swarm/config.json`) → project (`.factory/config.json`) →
plugin options in `opencode.json`. An unknown key in a config file is rejected; an unknown
plugin option is ignored with a warning (TUI toast and `/config`). Generated: do not edit by hand.

| field | type | default | description |
| --- | --- | --- | --- |
| `models` | object | — | Abstract model tiers mapped to concrete provider/model ids; unset tiers inherit the session default. |
| `afterEdit` | string (fast, off) | `"fast"` | Gates after each programmer edit: fast built-ins or off (the phase-end gates always run). |
| `estimate` | object | — | Spend estimates used when the host reports no cost; estimates are labelled as such. Global config or plugin options only. |
| `pr` | string (gh, off) | `"gh"` | Release PR opener: the GitHub CLI, or off. |
| `embeddings` | object | — | Optional OpenAI-compatible embeddings for brainstorm dedupe; unset uses MinHash/n-gram. Global config or plugin options only. |
| `lspAfterEdit` | boolean | `true` | Append language-server diagnostics to edit results. |
| `searchProvider` | string (brave, firecrawl, searxng) | — | Web search provider; the default is the first one with credentials. |
| `research` | object | `{"depth":2}` | Research-stage tunables (ported from the 0.7 configure tool). |
| `domainPack` | string | — | Active domain-pack constitution for RESEARCH (quant, biopharma or legal); unset keeps the legacy flat behaviour. |
| `licenseWhitelist` | array | `["MIT","Apache-2.0","BSD-2-Clause","BSD-3-Clause","ISC","0BSD","Unlicense","CC0-1.0"]` | SPDX ids darkharvest may depend on or vendor (a harvest plan may only narrow it); everything else is clean-room only. |
| `audit` | object | `{"phase":"optional"}` | Code-audit gating tunables (set with `es config set audit.phase required`). |

Nested `models.*` keys (fail-closed: malformed refs and unknown agent ids are rejected at load; a
configured model missing on the host refuses that seat at launch):

| field | description |
| --- | --- |
| `models.fast` | Model for fast-tier seats (lenses), "provider/model". |
| `models.balanced` | Model for balanced-tier seats (programmer, QA, research). |
| `models.deep` | Model for deep-tier seats (factory, grill, managers, critics). |
| `models.agents` | Per-agent model overrides by agent id. |

`es config show` and `/config` print the effective config and which files contributed.
