// `es-fleet`: the human-only fleet daemon CLI (#122). `start` and `stop`
// refuse agent sandboxes outright and `start` additionally requires an
// interactive terminal plus an explicit confirmation, because a running
// fleet spends money. `status` is read-only and agent-safe.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { stateDir } from "@heretek-ai/es-core"
import { assertHumanStart, FleetError, fleetStatus, startFleet, stopFleet } from "./lifecycle.ts"

export const VERSION = "0.1.0"

const HELP = `es-fleet ${VERSION} — Epistemic Swarm fleet daemon (human-only, except status)

Usage:
  es-fleet start --max-usd <n> [--concurrency <k>] [--foreground]   start the daemon (TTY + confirmation)
  es-fleet stop                                                     stop the daemon
  es-fleet status [--json]                                          show daemon status (agent-safe)

Options:
  --state-dir <dir>   override the user state dir (default: es state dir)
  --help              show this help
`

const valueFlag = (args: string[], names: readonly string[]): string | undefined => {
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name) return args[i + 1]
      if (args[i]?.startsWith(`${name}=`)) return args[i]!.slice(name.length + 1)
    }
  }
  return undefined
}
const hasFlag = (args: string[], name: string): boolean => args.includes(name)

const confirm = (question: string): Promise<boolean> =>
  new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(/^y(es)?$/i.test(answer.trim()))
    })
  })

export async function main(argv: readonly string[]): Promise<number> {
  const args = [...argv]
  if (hasFlag(args, "--help") || args.length === 0) {
    process.stdout.write(HELP)
    return 0
  }
  const [command, ...rest] = args
  const root = valueFlag(args, ["--state-dir"]) ?? stateDir()
  try {
    switch (command) {
      case "start": {
        assertHumanStart(process.env)
        if (!process.stdin.isTTY || !process.stdout.isTTY)
          throw new FleetError(
            "Refusing to start the fleet without an interactive terminal: run `es-fleet start` yourself; agents cannot start it.",
          )
        const maxUsd = Number(valueFlag(rest, ["--max-usd"]))
        const concurrency = Number(valueFlag(rest, ["--concurrency"]) ?? "4")
        if (!hasFlag(rest, "--foreground")) {
          const answer = await confirm(
            `Start the fleet daemon (ceiling $${valueFlag(rest, ["--max-usd"]) ?? "?"}, concurrency ${Number.isFinite(concurrency) ? concurrency : "?"} Workers run headless factory runs that spend real money. [y/N] `,
          )
          if (!answer) {
            process.stdout.write("Not starting.\n")
            return 1
          }
          // Daemonize: respawn detached and let the child own the pidfile.
          const child = spawn(process.execPath, [process.argv[1]!, ...args, "--foreground"], {
            detached: true,
            stdio: "ignore",
            env: process.env,
          })
          child.unref()
          process.stdout.write(`Fleet daemon starting (pid ${child.pid}).\n`)
          return 0
        }
        const handle = await startFleet({ stateRoot: root, maxUsd, concurrency })
        process.stdout.write(
          `Fleet daemon running (pid ${handle.pid}, ceiling $${maxUsd}, started ${handle.startedAt}).\n`,
        )
        const shutdown = async () => {
          await handle.close()
          process.exit(0)
        }
        process.once("SIGTERM", () => void shutdown())
        process.once("SIGINT", () => void shutdown())
        // Park the foreground daemon until it is signalled.
        await new Promise(() => {})
        return 0
      }
      case "stop": {
        assertHumanStart(process.env)
        const { stopped } = await stopFleet(root)
        process.stdout.write(stopped ? "Fleet daemon stopped.\n" : "The fleet is not running.\n")
        return 0
      }
      case "status": {
        const status = await fleetStatus(root)
        if (hasFlag(rest, "--json")) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
        else if (status.running)
          process.stdout.write(
            `Fleet running (pid ${status.pid}, ceiling $${status.maxUsd}, concurrency ${status.concurrency}, started ${status.startedAt}).\n`,
          )
        else process.stdout.write("Fleet stopped.\n")
        return 0
      }
      default:
        process.stderr.write(`Unknown command ${JSON.stringify(command ?? "")}.\n\n${HELP}`)
        return 1
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
