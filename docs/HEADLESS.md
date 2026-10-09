# Headless runs (`es factory run --headless`)

A headless run drives one factory seat through a harness CLI (`opencode
run`, later `claude -p` / `pi -p`) until the job finishes, the run halts,
progress stalls, the turn cap is reached, a turn times out, or a signal
cancels it. It never answers human checkpoints: it stops and reports when an
approval is pending, the grill needs a human, or the run halts. Launching
one stays human-only (spend-bearing, like audit/scout runs).

## Human output

Without flags the run prints one JSON object per line (see `presentEvent`
in `packages/cli/src/headless.ts`): lifecycle events always, one compact
line per tool call and the assistant's text at the default `info` level,
raw harness events with long strings clipped at `debug`, lifecycle and
progress only at `quiet`. Per-turn metrics are not printed; they go to the
event stream below.

## Machine-readable event stream (`--events jsonl`)

`--events jsonl` replaces the human lines with one versioned envelope per
line on stdout:

```json
{"v":1,"at":"2026-10-09T12:00:00.000Z","runId":"run-20261009-120000-abcd","kind":"turn-metrics","event":{"type":"turn-metrics","turn":3,"costUSD":0.04,"tools":[{"name":"read","ok":true}]}}
```

- `v` is the envelope version (1; bumped on any incompatible change).
- `kind` mirrors the event's `type`: `start`, `turn`, `driver`,
  `progress`, `turn-metrics`, `waiting`, `halted`, `stalled`, `turn-cap`,
  `cancelled`, `done`, `error`.
- `turn-metrics` follows every completed turn: `turn`, `costUSD` (the
  sealed run-state spend delta across the turn), opportunistic
  `tokensIn`/`tokensOut` (only when the driver reports them), and `tools`
  (`name`, `ok`, optional `ms`).
- `--events-file <path>` writes the envelopes to the file instead, keeping
  the human lines on stdout.

The envelope's type and Zod schema are exported from the CLI package for
the fleet to parse: `JsonlEnvelope`, `HeadlessJsonlSchema`, `toJsonl`
(`packages/cli/src/headless.ts`).

## Cancellation and turn timeouts

- SIGINT/SIGTERM abort the current turn (the child harness is killed through
  the driver's abort signal), the run emits `cancelled` and exits **130**.
  No halt is written and no STOP file is created: re-running resumes where
  it stopped.
- `--turn-timeout <seconds>` aborts a turn that runs longer and reports it
  as an `error` with reason `turn-timeout` (the run ends; the state is
  untouched).

## Worktrees (`--cwd`)

`--cwd <dir>` points the run at a git worktree. Two refusals (exit 2):

- inside another active run's `.factory/worktrees/` (a seat worktree is not
  a run root);
- a checkout with a detached HEAD (a run must be attributable to a branch).

The `--cwd` path is the run's root, so it is recorded in the per-user run
index (`es runs`) at headless start.

## Sample transcript

```
{"v":1,"at":"…","runId":"run-7","kind":"start","event":{"type":"start","runId":"run-7","stage":"RESEARCH","driver":"opencode","monitor":"…"}}
{"v":1,"at":"…","runId":"run-7","kind":"turn","event":{"type":"turn","n":1,"stage":"RESEARCH","activePhase":"p2"}}
{"v":1,"at":"…","runId":"run-7","kind":"driver","event":{"type":"driver","event":{"type":"tool_use","part":{"tool":"read","state":{"status":"completed","input":{"path":"src/a.ts"}}}}}}
{"v":1,"at":"…","runId":"run-7","kind":"turn-metrics","event":{"type":"turn-metrics","turn":1,"costUSD":0.04,"tools":[{"name":"read","ok":true}]}}
{"v":1,"at":"…","runId":"run-7","kind":"cancelled","event":{"type":"cancelled","reason":"cancelled by signal; the run state is untouched, re-run to resume"}}
```
