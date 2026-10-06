// `es`: the Epistemic Swarm CLI. Human-only actions (approve, trust, waive,
// resume, git hooks) require an interactive terminal and a typed code; agent
// shells are denied these commands by policy as well.
import path from "node:path"
import {
  atomicWrite,
  capabilityLoss,
  Factory,
  factoryLayout,
  factorySummary,
  gateRunner,
  git,
  HookEngine,
  loadHooks,
  verifyAuditChain,
} from "@heretek-ai/es-core"
import { type Args, flag, parseArgs } from "./args.ts"
import { gatesRun, installGitHooks } from "./gates.ts"
import { DRIVERS, runHeadless } from "./headless.ts"
import { approve, type HumanContext, recordPr, resume, trust, waive } from "./human.ts"
import { serveStdio } from "./mcp.ts"
import { type ConfirmIO, NotInteractive, terminalIO } from "./tty.ts"

export const VERSION = "1.0.0"

const HELP = `es ${VERSION} — Epistemic Swarm build factory

Usage: es [--cwd <dir>] <command>

Factory
  status                        Show the factory state
  factory begin                 Start a run (normally done by /grill)
  factory run --headless        Drive the factory through a harness CLI, emitting JSON lines
        [--driver opencode] [--max-turns N]
  factory stop [reason]         Create .factory/STOP (kill switch)
  factory resume                Clear a halt            [human, TTY]
        [--accept-drift] [--raise-ceiling USD] [--extend-runtime]
  factory pr <url>              Record a release PR opened by hand   [human, TTY]

Checkpoints and exceptions                                      [human, TTY]
  approve <frontier|spec>       Approve a checkpoint (shows hashes; type the code)
  trust [--show]                Approve this project's gate commands by hash
  waive <rule> --reason "…" [--files <glob>] [--expires 7d] [--id <name>]

Gates
  gates run [--full] [--staged] [--base <ref>] [--json] [files…]
  gates install-git [--uninstall]   Opt-in pre-commit/pre-push gates   [human, TTY]

Other
  hooks                         Hook bridge status, trust and per-harness capability loss
  audit verify                  Verify the hash-chained audit log
  mcp                           Serve the factory tools over MCP (stdio)
  version
`

export interface MainIO {
  readonly print: (text: string) => void
  readonly confirm: ConfirmIO
  readonly cwd: string
  readonly stateDir?: string
}

async function projectRoot(cwd: string): Promise<string> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"], { allowFail: true })
  return top.code === 0 ? top.stdout.trim() : cwd
}

const BOOLEAN_FLAGS = [
  "full",
  "staged",
  "json",
  "show",
  "headless",
  "accept-drift",
  "extend-runtime",
  "uninstall",
  "help",
]

export async function main(argv: readonly string[], io: MainIO): Promise<number> {
  const args = parseArgs(argv, BOOLEAN_FLAGS)
  const [command, sub, ...rest] = args.positionals
  const root = await projectRoot(path.resolve(io.cwd, flag(args, "cwd") ?? "."))
  const context: HumanContext = {
    root,
    io: io.confirm,
    print: io.print,
    ...(io.stateDir ? { stateDir: io.stateDir } : {}),
  }
  const subArgs = (from: number): Args => ({ positionals: args.positionals.slice(from), flags: args.flags })
  const factory = () =>
    new Factory(root, {
      gates: gateRunner(io.stateDir ? { stateDir: io.stateDir } : {}),
      ...(io.stateDir ? { stateDir: io.stateDir } : {}),
    })

  try {
    switch (command) {
      case undefined:
      case "help":
        io.print(HELP)
        return 0
      case "version":
        io.print(VERSION)
        return 0
      case "status":
        io.print(factorySummary(await factory().read()))
        return 0
      case "approve":
        return await approve(context, subArgs(1))
      case "trust":
        return await trust(context, subArgs(1))
      case "waive":
        return await waive(context, subArgs(1))
      case "hooks": {
        const engine = await HookEngine.create({
          root,
          ...(io.stateDir ? { stateDir: io.stateDir } : {}),
          audit: false,
        })
        const status = engine.status()
        const loaded = await loadHooks(root)
        const trust =
          status.projectHandlers === 0 ? "nothing to trust" : status.trusted ? "trusted" : "NOT trusted (es trust)"
        const lines = [
          `${status.handlers} hook handler(s); ${status.projectHandlers} from the project (${trust}).`,
          ...status.projectLines,
          ...status.diagnostics.map((item) => `! ${item}`),
        ]
        for (const harness of ["claude", "opencode", "pi", "antigravity"] as const) {
          const loss = capabilityLoss(loaded.handlers, harness)
          lines.push(`${harness}: ${loss.length ? loss.map((item) => item.reason).join("; ") : "all enforced"}`)
        }
        io.print(lines.join("\n"))
        return 0
      }
      case "audit": {
        if (sub !== "verify") break
        const result = await verifyAuditChain(root)
        io.print(
          result.valid ? `Audit log OK (${result.entries.length} entries).` : `Audit log INVALID: ${result.error}`,
        )
        return result.valid ? 0 : 1
      }
      case "gates":
        if (sub === "run") return await gatesRun(context, subArgs(2))
        if (sub === "install-git") return await installGitHooks(context, subArgs(2))
        break
      case "mcp":
        await serveStdio({
          root,
          version: VERSION,
          ...(io.stateDir ? { stateDir: io.stateDir } : {}),
          ...(process.env.ES_AGENT ? { defaultAgent: process.env.ES_AGENT } : {}),
        })
        return 0
      case "factory": {
        if (sub === "begin") {
          io.print(factorySummary(await factory().begin("human:cli")))
          return 0
        }
        if (sub === "status") {
          io.print(factorySummary(await factory().read()))
          return 0
        }
        if (sub === "resume") return await resume(context, subArgs(2))
        if (sub === "pr") return await recordPr(context, subArgs(2))
        if (sub === "stop") {
          await atomicWrite(factoryLayout(root).stop, `${rest.join(" ") || "stopped from the CLI"}\n`)
          io.print(
            "Created .factory/STOP; the factory halts at its next step. Delete it and run `es factory resume` to continue.",
          )
          return 0
        }
        if (sub === "run") {
          if (!args.flags.headless) {
            io.print(
              "Interactive runs happen in your harness (/factory in OpenCode). Use --headless for an unattended run.",
            )
            return 2
          }
          const driver = DRIVERS[flag(args, "driver") ?? "opencode"]
          if (!driver) {
            io.print(`Unknown driver. Available: ${Object.keys(DRIVERS).join(", ")}`)
            return 2
          }
          let code = 0
          for await (const event of runHeadless({
            root,
            driver,
            ...(flag(args, "max-turns") ? { maxTurns: Number(flag(args, "max-turns")) } : {}),
            ...(io.stateDir ? { stateDir: io.stateDir } : {}),
          })) {
            io.print(JSON.stringify(event))
            if (event.type === "error" || event.type === "halted" || event.type === "stalled") code = 1
          }
          return code
        }
        break
      }
    }
    io.print(`Unknown command: ${args.positionals.join(" ")}\n\n${HELP}`)
    return 2
  } catch (error) {
    if (error instanceof NotInteractive) {
      io.print(error.message)
      return 3
    }
    io.print(`Error: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), {
    print: (text) => console.log(text),
    confirm: terminalIO(),
    cwd: process.cwd(),
  })
  process.exit(code)
}
