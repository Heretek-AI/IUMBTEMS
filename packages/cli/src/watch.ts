// `es watch` (1.1.3, #61): `es status` redrawn every few seconds in the
// terminal, for following a run without the TUI (a headless run, another
// project). q or ctrl+c quits. It needs a terminal: an agent shell has none,
// so an agent can never hang on it.
import type { Args } from "./args.ts"
import { flag } from "./args.ts"
import { type StatusContext, statusSnapshot } from "./status.ts"

export interface WatchIO {
  /** Both stdin and stdout are a terminal. */
  readonly interactive: boolean
  write(text: string): void
  /** Deliver each keypress (raw mode); returns the unsubscribe. */
  onKey(listener: (key: string) => void): () => void
}

/** The process terminal: raw-mode stdin for single keypresses, stdout for frames. */
export function terminalWatchIO(): WatchIO {
  return {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    write: (text) => {
      process.stdout.write(text)
    },
    onKey(listener) {
      if (!process.stdin.isTTY) return () => {}
      process.stdin.setRawMode(true)
      process.stdin.setEncoding("utf8")
      process.stdin.resume()
      const handler = (chunk: string) => {
        for (const key of chunk) listener(key)
      }
      process.stdin.on("data", handler)
      return () => {
        process.stdin.off("data", handler)
        process.stdin.setRawMode(false)
        process.stdin.pause()
      }
    },
  }
}

/** Clear the screen and home the cursor. */
const CLEAR = "\x1b[2J\x1b[H"
const CTRL_C = "\u0003"
const MIN_INTERVAL_S = 0.2

export async function watchCommand(context: StatusContext, args: Args, io: WatchIO): Promise<number> {
  if (!io.interactive) {
    context.print("es watch needs a terminal; use `es status` (or `es status --json`) instead.")
    return 2
  }
  const interval = Number(flag(args, "interval") ?? 2)
  if (!Number.isFinite(interval) || interval < MIN_INTERVAL_S) {
    context.print(`--interval takes seconds (at least ${MIN_INTERVAL_S}).`)
    return 2
  }
  let stopped = false
  let wake: (() => void) | undefined
  const off = io.onKey((key) => {
    if (key === "q" || key === CTRL_C) {
      stopped = true
      wake?.()
    }
  })
  try {
    while (!stopped) {
      const body = await statusSnapshot(context).then(
        (snapshot) => snapshot.text,
        (error: unknown) => `Cannot read the run: ${error instanceof Error ? error.message : String(error)}`,
      )
      const clock = (context.now?.() ?? new Date()).toTimeString().slice(0, 8)
      io.write(`${CLEAR}${body}\n\nq quit · refreshes every ${interval}s · ${clock}\n`)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, interval * 1000)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
  } finally {
    off()
  }
  return 0
}
