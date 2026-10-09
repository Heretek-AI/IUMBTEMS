// `es-fleet`: the human-only fleet daemon CLI (#122). `start` and `stop`
// refuse agent sandboxes outright and `start` additionally requires an
// interactive terminal plus an explicit confirmation, because a running
// fleet spends money. `status` is read-only and agent-safe. `web` (#129)
// prints a one-time browser URL for the local control plane.
import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"
import { stateDir } from "@heretek-ai/es-core"
import { FleetDaemon } from "./daemon.ts"
import { assertHumanStart, FleetError, fleetStatus, startFleet, stopFleet } from "./lifecycle.ts"
import { reportTask } from "./scheduler.ts"
import { addTask, loadDag, saveDag, TERMINAL } from "./tasks.ts"
import { ensureToken, readTelemetryEndpoint, TelemetryServer } from "./telemetry.ts"
import { readFleetSnapshot, watchFleet } from "./watch.ts"
import { mintWebTicket } from "./web.ts"
import { defaultGateCheck } from "./worker.ts"
import { gcWorktrees } from "./worktree.ts"

export const VERSION = "0.1.0"

const HELP = `es-fleet ${VERSION} — Epistemic Swarm fleet daemon (human-only, except status)

Usage:
  es-fleet start --max-usd <n> [--concurrency <k>] [--foreground]   start the daemon (TTY + confirmation)
        [--repo <dir>] [--es-bin <path>] [--port <n>] [--interval-ms <ms>]
  es-fleet stop                                                     stop the daemon
  es-fleet status [--json]                                          show daemon status (agent-safe)
  es-fleet task add --file <task.json>                              add a task from a JSON file (human-only)
  es-fleet task list [--json]                                       list tasks
  es-fleet task cancel <id> [--reason <text>]                       cancel a task (human-only)
  es-fleet gc [--repo <dir>]                                        remove orphaned worktrees (human-only)
  es-fleet watch                                                    live dashboard over the telemetry bus
  es-fleet web                                                      print a one-time browser URL for the web UI (human-only)

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
        // Own the task loop: recover workers, then tick until signalled.
        const esBin = valueFlag(rest, ["--es-bin"]) ?? "es"
        const token = await ensureToken(root)
        const repoRoot = valueFlag(rest, ["--repo"]) ?? process.cwd()
        const webRoot = valueFlag(rest, ["--web-root"]) ?? path.join(repoRoot, "packages", "web", "dist")
        const bus = new TelemetryServer({
          stateRoot: root,
          port: Number(valueFlag(rest, ["--port"]) ?? "0"),
          token,
          getSnapshot: () => readFleetSnapshot(root),
          webRoot,
        })
        const daemon = new FleetDaemon({
          repoRoot,
          stateRoot: root,
          esBin,
          ...(Number.isFinite(concurrency) ? { concurrency } : {}),
          fleetCeilingUsd: maxUsd,
          checkGates: defaultGateCheck(esBin),
          onTransition: (event) =>
            void bus.log.appendSync("changed", { taskId: event.taskId, kind: event.type, detail: event.detail ?? "" }),
        })
        await daemon.recover()
        await bus.start()
        process.stdout.write(`Telemetry bus on 127.0.0.1:${bus.port} (token in <stateDir>/fleet/token).\n`)
        await daemon.tick()
        const everyMs = Math.max(1_000, Number(valueFlag(rest, ["--interval-ms"]) ?? "5000"))
        const timer = setInterval(
          () => void daemon.tick().catch((error) => process.stderr.write(`${String(error)}\n`)),
          everyMs,
        )
        timer.unref?.()
        const shutdown = async () => {
          clearInterval(timer)
          await daemon.shutdown()
          await bus.stop()
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
      case "task": {
        const [sub, ...taskArgs] = rest
        if (sub === "list") {
          const dag = await loadDag(root)
          const tasks = dag ? Object.values(dag.tasks).sort((a, b) => (a.id < b.id ? -1 : 1)) : []
          if (hasFlag(taskArgs, "--json")) process.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`)
          else if (tasks.length === 0) process.stdout.write("No tasks.\n")
          else
            for (const task of tasks)
              process.stdout.write(
                `${task.id}\t${task.status}\tdeps=[${task.deps.join(",")}]\t$${task.ceilingUSD}\t${task.title}\n`,
              )
          return 0
        }
        // Mutating task commands are human-only: the policy denies agents,
        // and the binary refuses sandboxes too.
        assertHumanStart(process.env, "change fleet tasks")
        if (sub === "add") {
          const file = valueFlag(taskArgs, ["--file"])
          if (!file) throw new FleetError("`es-fleet task add` needs --file <task.json>.")
          const raw = JSON.parse(await readFile(file, "utf8")) as unknown
          const inputs = Array.isArray(raw) ? raw : [raw]
          let dag = (await loadDag(root)) ?? { v: 1 as const, tasks: {} }
          const now = new Date().toISOString()
          for (const input of inputs) dag = addTask(dag, input as Record<string, unknown>, now)
          await saveDag(root, dag)
          process.stdout.write(`Added ${inputs.length} task(s).\n`)
          return 0
        }
        if (sub === "cancel") {
          const id = taskArgs[0]
          if (!id) throw new FleetError("`es-fleet task cancel` needs a task id.")
          const dag = await loadDag(root)
          const task = dag?.tasks[id]
          if (!task) throw new FleetError(`Unknown task ${JSON.stringify(id)}.`)
          if (TERMINAL.has(task.status)) throw new FleetError(`Task ${id} is already ${task.status}.`)
          const reason = valueFlag(taskArgs, ["--reason"]) ?? "cancelled by human"
          const next = reportTask(dag!, id, { outcome: "cancelled", reason }, new Date().toISOString())
          await saveDag(root, next.dag)
          process.stdout.write(`Cancelled ${id}.\n`)
          return 0
        }
        throw new FleetError(`Unknown task subcommand ${JSON.stringify(sub ?? "")}: want add, list or cancel.`)
      }
      case "gc": {
        assertHumanStart(process.env, "collect fleet worktrees")
        const repo = valueFlag(rest, ["--repo"]) ?? process.cwd()
        const report = await gcWorktrees(repo, root)
        process.stdout.write(
          `gc: removed ${report.removed.length} worktree(s), salvaged ${report.salvaged.length} branch(es), dropped ${report.dropped.length} record(s).\n`,
        )
        return 0
      }
      case "watch": {
        return watchFleet({ stateRoot: root })
      }
      case "web": {
        // Opening the UI is a human action: agents run sandboxed and are
        // refused here, and the printed ticket redeems exactly once.
        assertHumanStart(process.env, "open the fleet web UI")
        const endpoint = await readTelemetryEndpoint(root)
        if (!endpoint) throw new FleetError("The fleet is not running: start it first with `es-fleet start`.")
        const ticket = await mintWebTicket(root)
        process.stdout.write(`http://127.0.0.1:${endpoint.port}/?t=${ticket}\n`)
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
