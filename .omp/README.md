# IUMBTEMS for OMP (oh-my-pi / `omp.sh`)

Project-local OMP surface. Global install mirrors live under
`~/.oh-omp/agent/{commands,prompts,hooks}/` (copy these files there for
every-project availability).

## Install as OMP plugin package

This repo declares both manifest keys in `package.json`:

```json
{
  "pi": { "extensions": ["./extensions/pi/index.js"], "skills": [...], "prompts": [...] },
  "omp": { "extensions": ["./extensions/pi/index.js"], "skills": [...], "prompts": [...] }
}
```

```bash
omp install npm:@heretek-ai/epistemic-swarm
# local dev:
omp -e ./extensions/pi/index.js
omp list
tail -F ~/.omp/logs/omp.$(date +%F).log  # extension load errors land here, not the TUI
```

## Project-local surfaces in this directory

```
.omp/
├── README.md            # this file
├── SYSTEM.md            # project system-prompt override (safe subset of base_epistemic_system.md)
├── commands/*.md        # reusable slash commands: /swarm /grill /audit /scout /brainstorming /swarm-config
├── prompts/*.md         # prompt templates with `description:` frontmatter + $1/$@ expansion
└── hooks/pre/*.ts       # pre-tool hooks (epistemic redirect)
└── hooks/post/*.ts      # post-tool hooks (audit-trail log)
```

Commands return a string sent as the LLM prompt, or execute shell via the
Bun worker and return output. All runners write only under `.research/`.
