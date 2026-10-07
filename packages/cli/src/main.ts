// `es`: the Epistemic Swarm CLI. Human-only actions (approve, trust, waive,
// resume, git hooks) require an interactive terminal and a typed code; agent
// shells are denied these commands by policy as well.
import { readFile } from "node:fs/promises"
import path from "node:path"
import {
  aliasReuseRatio,
  atomicWrite,
  brainstormPaths,
  buildPlan,
  candidateId,
  capabilityLoss,
  checkDrift,
  compileToCssVars,
  designPaths,
  Factory,
  factoryLayout,
  factorySummary,
  findOneOffs,
  formatDiagnostics,
  gateRunner,
  git,
  HookEngine,
  harvestPaths,
  installServer,
  LENSES,
  LspManager,
  loadEsConfig,
  loadHooks,
  loadInterview,
  parseSource,
  readIdeas as readBrainstormIdeas,
  readPlan as readBrainstormPlan,
  readResult as readBrainstormResult,
  readScores as readBrainstormScores,
  readHarvestPlan,
  readProfiles as readHarvestProfiles,
  readHarvestResult,
  readProbes,
  readTokens,
  recordConsent,
  renderBrainstorm,
  renderGuide,
  researchTools,
  SlotLoop,
  scanSource,
  startRun as startBrainstorm,
  validateTokens,
  verifyAuditChain,
  writeArtifacts,
  writeProfile,
} from "@heretek-ai/es-core"
import { type Args, flag, parseArgs } from "./args.ts"
import { gatesRun, installGitHooks } from "./gates.ts"
import { DRIVERS, runHeadless } from "./headless.ts"
import { approve, type HumanContext, recordPr, resume, trust, waive } from "./human.ts"
import { serveStdio } from "./mcp.ts"
import { type ConfirmIO, confirmWithCode, NotInteractive, terminalIO } from "./tty.ts"

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
  research search <query>       Search with the configured provider
  research fetch <url>          Fetch and cache a source (prints its sha256)
  research audit [file] [--prune]  Epistemic audit of a research report
  brainstorm plan "<idea>"      Freeze a lens fan-out plan (.factory/brainstorm)
        [--lenses a,b] [--ideas N] [--shortlist N] [--force]
  brainstorm show [--json]      Show the plan/progress or the finished shortlist
  brainstorm lenses             List the built-in divergent lenses
  harvest show [--json]         Show the teardown plan/progress or the report
  harvest scan <source>         Scan one source (local path, git URL, github:owner/repo, npm:name)
  design [status]               Design interview progress (resumes from .factory/design)
  design render                 Re-render tokens.css + STYLE_GUIDE.md from tokens.json
  design check                  Fail on render drift, invalid tokens or one-off mints
  config show                   Show the effective config and its layers
  lsp [status]                  Language servers and how each resolves
  lsp diagnostics <file>        Diagnostics for one file
  lsp install <server>          Pinned, checksummed install   [human, TTY]
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
  "force",
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
      case "research": {
        const tools = researchTools({
          root,
          policy: async () => ({ root, ...(io.stateDir ? { stateDir: io.stateDir } : {}) }),
        })
        const tool = (name: string) => tools.find((item) => item.name === name)!
        if (sub === "search" && rest.length) {
          io.print(await tool("es_research_search").execute({ query: rest.join(" ") }, { agent: "human" }))
          return 0
        }
        if (sub === "fetch" && rest[0]) {
          io.print((await tool("es_research_fetch").execute({ url: rest[0] }, { agent: "human" })).split("\n---\n")[0]!)
          return 0
        }
        if (sub === "audit") {
          const text = await tool("es_research_audit").execute(
            { ...(rest[0] ? { path: rest[0] } : {}), prune: args.flags.prune === true },
            { agent: "human" },
          )
          io.print(text)
          return /Audit passed/.test(text) || /Pruned/.test(text) ? 0 : 1
        }
        io.print("Usage: es research search <query> | fetch <url> | audit [file] [--prune]")
        return 2
      }
      case "brainstorm": {
        const paths = brainstormPaths(root)
        if (sub === "lenses") {
          io.print(LENSES.map((lens) => `${lens.id.padEnd(18)} ${lens.name} — ${lens.summary}`).join("\n"))
          return 0
        }
        if (sub === "plan") {
          const idea = rest.join(" ").trim()
          if (!idea) {
            io.print('Usage: es brainstorm plan "<idea>" [--lenses a,b] [--ideas N] [--shortlist N] [--force]')
            return 2
          }
          const existing = await readBrainstormPlan(root).catch(() => undefined)
          const recorded = existing ? await readBrainstormIdeas(root).catch(() => []) : []
          if (existing && recorded.length && args.flags.force !== true) {
            io.print(
              `A brainstorm is already in progress (${recorded.length} idea(s) in ${paths.dir}). Re-run with --force to replace it.`,
            )
            return 1
          }
          const lenses = flag(args, "lenses")
            ?.split(",")
            .map((item) => item.trim())
            .filter(Boolean)
          const ideas = flag(args, "ideas") ? Number(flag(args, "ideas")) : undefined
          const shortlist = flag(args, "shortlist") ? Number(flag(args, "shortlist")) : undefined
          let built: ReturnType<typeof buildPlan>
          try {
            built = buildPlan(
              { idea },
              {
                ...(lenses?.length ? { lenses } : {}),
                ...(ideas !== undefined ? { ideasPerLens: ideas } : {}),
                ...(shortlist !== undefined ? { shortlistSize: shortlist } : {}),
              },
            )
          } catch (error) {
            io.print(error instanceof Error ? error.message : String(error))
            return 1
          }
          await startBrainstorm(root, built.plan)
          io.print(
            [
              `Planned "${built.plan.brief.idea}" in ${paths.dir}`,
              `Lenses: ${built.plan.lenses.join(", ")}`,
              `Caps: ≤${built.plan.ideasPerLens} ideas/lens · shortlist ${built.plan.shortlistSize}`,
              `Run it in OpenCode with /brainstorm, or record ideas manually (the brainstormer tools enforce the caps).`,
            ].join("\n"),
          )
          return 0
        }
        if (sub === "show" || sub === undefined) {
          const result = await readBrainstormResult(root).catch(() => undefined)
          if (result) {
            io.print(args.flags.json === true ? JSON.stringify(result, null, 2) : renderBrainstorm(result))
            return 0
          }
          const plan = await readBrainstormPlan(root).catch(() => undefined)
          if (plan) {
            const ideas = await readBrainstormIdeas(root).catch(() => [])
            const scores = await readBrainstormScores(root).catch(() => [])
            const survivors = ideas.filter((idea) => !idea.duplicateOf)
            io.print(
              [
                `Brainstorm in progress: "${plan.brief.idea}"`,
                `Lenses: ${plan.lenses.join(", ")}`,
                `Ideas: ${survivors.length} surviving (${ideas.length - survivors.length} duplicate(s)) · scored ${scores.length}/${survivors.length}`,
                `Coverage: ${plan.lenses.map((lens) => `${lens} ${survivors.filter((idea) => idea.lens === lens).length}`).join(" · ")}`,
              ].join("\n"),
            )
            return 0
          }
          io.print(
            `No brainstorm in ${paths.dir}. Start one with /brainstorm in OpenCode, or \`es brainstorm plan "<idea>"\`.`,
          )
          return 1
        }
        io.print('Usage: es brainstorm plan "<idea>" | show [--json] | lenses')
        return 2
      }
      case "harvest": {
        const paths = harvestPaths(root)
        if (sub === "scan" && rest.length) {
          const spec = rest.join(" ")
          const source = parseSource(spec)
          const name =
            source.kind === "local"
              ? path.basename(path.resolve(root, source.path))
              : source.kind === "registry"
                ? source.name
                : (source.kind === "git" ? source.url : source.repo)
                    .split("/")
                    .filter(Boolean)
                    .pop()!
                    .replace(/\.git$/, "")
          const id = candidateId(name)
          try {
            const profile = await scanSource(root, id, source, {})
            await writeProfile(root, profile)
            io.print(
              [
                `Scanned ${id}: ${profile.name}`,
                `License: ${profile.license.spdx} (${profile.license.family}, ${profile.license.source}, ${profile.license.verified ? "verified" : "UNVERIFIED"})`,
                `Size: ${profile.size.files} files, ~${profile.size.tokens} tokens`,
                ...profile.warnings.map((warning) => `⚠ ${warning}`),
                `Written: ${paths.profile(id)}`,
              ].join("\n"),
            )
            return 0
          } catch (error) {
            io.print(error instanceof Error ? error.message : String(error))
            return 1
          }
        }
        if (sub === "show" || sub === undefined) {
          const result = await readHarvestResult(root).catch(() => undefined)
          if (result) {
            const report = await readFile(paths.report, "utf8").catch(() => undefined)
            io.print(
              args.flags.json === true ? JSON.stringify(result, null, 2) : (report ?? `${paths.report} is missing`),
            )
            return 0
          }
          const plan = await readHarvestPlan(root).catch(() => undefined)
          if (plan) {
            const profiles = await readHarvestProfiles(root).catch(() => [])
            const scanned = new Set(profiles.map((profile) => profile.id))
            io.print(
              [
                `Darkharvest in progress: ${plan.objective}`,
                `Candidates: ${plan.candidates.map((candidate) => `${candidate.id}${scanned.has(candidate.id) ? " ✓" : ""}`).join(", ")}`,
                `Scanned ${profiles.length}/${plan.candidates.length} · read budget ${plan.readTokensPerCandidate} tokens per candidate`,
              ].join("\n"),
            )
            return 0
          }
          io.print(
            `No darkharvest in ${paths.dir}. Start one with /harvest in OpenCode or \`es harvest scan <source>\`.`,
          )
          return 1
        }
        io.print("Usage: es harvest show [--json] | scan <source>")
        return 2
      }
      case "design": {
        const paths = designPaths(root)
        if (sub === "status" || sub === undefined) {
          const loop = new SlotLoop()
          const resumed = await loadInterview(root, loop)
          const total =
            Object.values(loop.values).reduce((sum, values) => sum + values.size, 0) +
            Object.values(loop.skipped).reduce((sum, skipped) => sum + skipped.size, 0)
          const next = loop.nextRequiredSlot()
          const lines = [
            resumed
              ? `Resumed the design interview from ${paths.interview}.`
              : `No interview yet in ${paths.dir}; start one with /design.`,
            next
              ? `${total} slot(s) settled. Next: ${next.axis}.${next.slot} — ${next.question}`
              : `${total} slot(s) settled; the interview is complete (es_design_complete, or \`es design render\` after completion).`,
          ]
          const tokens = await readTokens(root).catch(() => undefined)
          if (tokens) {
            const reuse = aliasReuseRatio(tokens)
            lines.push(
              `Tokens: ${reuse.total} (reuse ${reuse.ratio.toFixed(2)}), one-off mints ${findOneOffs(tokens).length}, validation errors ${validateTokens(tokens).length}`,
            )
          }
          io.print(lines.join("\n"))
          return 0
        }
        if (sub === "render") {
          const tokens = await readTokens(root).catch(() => undefined)
          if (tokens === undefined) {
            io.print(`No tokens.json in ${paths.dir} yet; finish the interview first.`)
            return 1
          }
          const probes = (await readProbes(root)) ?? []
          const outcomes = await writeArtifacts(root, {
            tokens,
            probes,
            guide: renderGuide(tokens, probes),
            css: compileToCssVars(tokens),
          })
          io.print(
            `Rendered ${paths.css} and ${paths.guide} (${outcomes.filter((outcome) => outcome.wrote).length} file(s) changed).`,
          )
          return 0
        }
        if (sub === "check") {
          const report = await checkDrift(root)
          const tokens = await readTokens(root).catch(() => undefined)
          const oneOffs = tokens ? findOneOffs(tokens) : []
          const failed = report.drifted.length + report.missing.length + report.tokenErrors.length + oneOffs.length
          io.print(
            [
              report.drifted.length || report.missing.length
                ? `Drift: ${[...report.drifted, ...report.missing.map((file) => `${file} (missing)`)].join(", ")}`
                : "STYLE_GUIDE.md and tokens.css byte-match the renderer output.",
              `Token errors: ${report.tokenErrors.length} · one-off mints: ${oneOffs.length}`,
              ...report.tokenErrors.slice(0, 5),
              ...oneOffs.slice(0, 5).map((item) => `${item.path}: ${item.reason}`),
            ].join("\n"),
          )
          return failed ? 1 : 0
        }
        io.print("Usage: es design [status] | render | check")
        return 2
      }
      case "config": {
        if (sub === "show" || sub === undefined) {
          try {
            const loaded = await loadEsConfig(root)
            io.print(
              [
                loaded.sources.length
                  ? `Layers: ${loaded.sources.join(" → ")}`
                  : "Layers: defaults only (no config files)",
                `Global: ${loaded.globalFile}`,
                `Project: ${loaded.projectFile}`,
                JSON.stringify(loaded.config, null, 2),
              ].join("\n"),
            )
            return 0
          } catch (error) {
            io.print(error instanceof Error ? error.message : String(error))
            return 1
          }
        }
        io.print("Usage: es config show")
        return 2
      }
      case "lsp": {
        const manager = new LspManager({ root, ...(io.stateDir ? { stateDir: io.stateDir } : {}) })
        try {
          if (sub === "install") {
            const id = rest[0]
            const server = (await manager.settings()).servers.find((item) => item.id === id)
            if (!server?.install) {
              io.print(id ? `${id} has no pinned install.` : "Usage: es lsp install <server>")
              return 2
            }
            const lines = [
              ...server.install.packages.map((pkg) => `${pkg.name}@${pkg.version}  ${pkg.integrity}`),
              "Verified against the pinned sha512; installed with scripts disabled.",
            ]
            if (!(await confirmWithCode(io.confirm, `Install the ${id} language server`, lines))) return 1
            await recordConsent(id!, true, io.stateDir)
            io.print(`Installed ${await installServer(server, io.stateDir ? { stateDir: io.stateDir } : {})}`)
            return 0
          }
          if (sub === "diagnostics" && rest[0]) {
            const result = await manager.diagnostics(rest[0], { maxWaitMs: 15_000 })
            if (!Array.isArray(result)) {
              io.print(result.unavailable)
              return 1
            }
            const lines = formatDiagnostics(root, path.resolve(root, rest[0]), result)
            io.print(lines.length ? lines.join("\n") : "No errors or warnings.")
            return lines.some((line) => / error/.test(line)) ? 1 : 0
          }
          const settings = await manager.settings()
          for (const server of settings.servers) {
            const command = await manager.command(server, root)
            io.print(`${server.id}: ${Array.isArray(command) ? command.join(" ") : command.unavailable}`)
          }
          return 0
        } finally {
          await manager.stopAll()
        }
      }
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
