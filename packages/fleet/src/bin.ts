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
import { fleetPaths } from "./state.ts"
import { addTask, emptyDag, loadDag, saveDag, TERMINAL } from "./tasks.ts"
import { ensureToken, readTelemetryEndpoint, TelemetryServer } from "./telemetry.ts"
import { readFleetSnapshot, watchFleet } from "./watch.ts"
import { mintWebTicket } from "./web.ts"
import { defaultGateCheck } from "./worker.ts"
import { gcWorktrees } from "./worktree.ts"

export const VERSION = "0.1.0"

/**
 * Start-gate decision (#122, repair-151 S5.2, pure and tested): the parent
 * does `assertHumanStart`, the TTY check and the confirmation, then spawns
 * the child with an IPC channel and a one-time start grant. A child without
 * a TTY runs only with that grant — no env var or flag grants it.
 */
export type StartDecision =
  | { readonly action: "run" }
  | { readonly action: "daemonize" }
  | { readonly action: "declined" }
  | { readonly action: "refuse"; readonly reason: string }

export function startDecision(input: {
  readonly isTTY: boolean
  readonly foreground: boolean
  readonly grant: boolean
  readonly confirm: boolean
}): StartDecision {
  if (!input.isTTY && !input.grant)
    return {
      action: "refuse",
      reason:
        "Refusing to start the fleet without an interactive terminal: run `es-fleet start` yourself; agents cannot start it.",
    }
  // `--foreground` also asks for the confirmation: spending money always does.
  if (input.isTTY && !input.confirm) return { action: "declined" }
  if (!input.foreground && input.isTTY) return { action: "daemonize" }
  return { action: "run" }
}

/** IPC message type carrying the one-time parent-to-child start grant. */
export const START_GRANT_TYPE = "es-fleet-start-grant" as const
/** IPC message type carrying the child's pidfile-written report to the parent. */
export const STARTED_TYPE = "es-fleet-started" as const
/** How long a TTY-less child waits for the parent's grant. */
export const START_GRANT_TIMEOUT_MS = 5_000
/** How long the parent waits for the child's pidfile-written report. */
export const STARTED_TIMEOUT_MS = 30_000

/**
 * Await the parent's one-time start grant over the IPC channel. Rejects
 * immediately without an IPC channel, and after START_GRANT_TIMEOUT_MS
 * without a grant. Nothing else (no env var, no flag) grants a start.
 */
export function awaitStartGrant(timeoutMs = START_GRANT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected)
      return reject(
        new FleetError(
          "Refusing to start the fleet without an interactive terminal: run `es-fleet start` yourself; agents cannot start it.",
        ),
      )
    const timer = setTimeout(() => {
      process.removeListener("message", onMessage)
      reject(new FleetError("Timed out waiting for the fleet start grant from the parent; refusing to start."))
    }, timeoutMs)
    const onMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === START_GRANT_TYPE
      ) {
        clearTimeout(timer)
        process.removeListener("message", onMessage)
        resolve()
      }
    }
    process.on("message", onMessage)
  })
}

/** True when the parent's one-time start grant arrives in time (never throws). */
async function receiveGrant(): Promise<boolean> {
  try {
    await awaitStartGrant()
    return true
  } catch {
    return false
  }
}

/** Wait for the daemonized child's pidfile-written report (or its failure). */
async function awaitChildStarted(
  child: import("node:child_process").ChildProcess,
  timeoutMs = STARTED_TIMEOUT_MS,
): Promise<{ ok: true; pid: number } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve({ ok: false, reason: "timed out waiting for the daemon child to report it started" })
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      child.removeListener("message", onMessage)
      child.removeListener("error", onError)
      child.removeListener("exit", onExit)
    }
    const onMessage = (message: unknown) => {
      if (typeof message === "object" && message !== null && (message as { type?: unknown }).type === STARTED_TYPE) {
        const pid = (message as { pid?: unknown }).pid
        cleanup()
        resolve({ ok: true, pid: typeof pid === "number" ? pid : (child.pid ?? -1) })
      }
    }
    const onError = (error: Error) => {
      cleanup()
      resolve({ ok: false, reason: error.message })
    }
    const onExit = (code: number | null, signal: string | null) => {
      cleanup()
      resolve({
        ok: false,
        reason: `the daemon child exited (code ${code}, signal ${signal}) before reporting it started`,
      })
    }
    child.on("message", onMessage)
    child.on("error", onError)
    child.on("exit", onExit)
  })
}

/**
 * Read the bus bearer token for `es-fleet status --token` (#126, S5.5).
 * Human-only through the TTY gate: agents run without one, and the state
 * dir is masked inside their sandboxes anyway.
 */
export async function readStatusToken(stateRoot: string, options: { isTTY: boolean }): Promise<string> {
  if (!options.isTTY)
    throw new FleetError(
      "Refusing to print the fleet token without an interactive terminal: run `es-fleet status --token` yourself; agents cannot read it.",
    )
  let token = ""
  try {
    token = (await readFile(fleetPaths(stateRoot).token, "utf8")).trim()
  } catch {
    // Missing file: reported below.
  }
  if (token.length < 32) throw new FleetError("No fleet token yet: start the fleet first with `es-fleet start`.")
  return token
}

const HELP = `es-fleet ${VERSION} — Epistemic Swarm fleet daemon (human-only, except status)

Usage:
  es-fleet start --max-usd <n> [--concurrency <k>] [--foreground]   start the daemon (TTY + confirmation)
        [--repo <dir>] [--es-bin <path>] [--port <n>] [--interval-ms <ms>]
  es-fleet stop                                                     stop the daemon
  es-fleet status [--json] [--token]                              show daemon status (agent-safe, except --token)
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
        const foreground = hasFlag(rest, "--foreground")
        const isTTY = !!process.stdin.isTTY && !!process.stdout.isTTY
        // A daemonized child carries no TTY: it runs only on the parent's
        // one-time IPC grant (no env var or flag grants it).
        const grant = isTTY ? false : await receiveGrant()
        const maxUsd = Number(valueFlag(rest, ["--max-usd"]))
        const concurrency = Number(valueFlag(rest, ["--concurrency"]) ?? "4")
        // Spending money always asks: background and --foreground alike.
        const confirmed = isTTY
          ? await confirm(
              `Start the fleet daemon (ceiling $${valueFlag(rest, ["--max-usd"]) ?? "?"}, concurrency ${Number.isFinite(concurrency) ? concurrency : "?"} Workers run headless factory runs that spend real money. [y/N] `,
            )
          : false
        const decision = startDecision({ isTTY, foreground, grant, confirm: confirmed })
        if (decision.action === "refuse") throw new FleetError(decision.reason)
        if (decision.action === "declined") {
          process.stdout.write("Not starting.\n")
          return 1
        }
        if (decision.action === "daemonize") {
          // Daemonize: respawn detached with an IPC channel, grant the one
          // start, and wait for the child's pidfile-written report before
          // claiming anything — the child's error is printed instead.
          const child = spawn(process.execPath, [process.argv[1]!, ...args, "--foreground"], {
            detached: true,
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            env: process.env,
          })
          child.send({ type: START_GRANT_TYPE })
          const started = await awaitChildStarted(child)
          child.disconnect()
          child.unref()
          if (!started.ok) throw new FleetError(`The fleet failed to start: ${started.reason}`)
          process.stdout.write(`Fleet daemon started (pid ${started.pid}).\n`)
          return 0
        }
        const handle = await startFleet({ stateRoot: root, maxUsd, concurrency })
        process.send?.({ type: STARTED_TYPE, pid: handle.pid, startedAt: handle.startedAt })
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
          configRoot: repoRoot,
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
        if (hasFlag(rest, "--token")) {
          const token = await readStatusToken(root, {
            isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
          })
          process.stdout.write(`${token}\n`)
          return 0
        }
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
          let dag = (await loadDag(root)) ?? emptyDag()
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
