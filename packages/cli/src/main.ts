// `es`: the Epistemic Swarm CLI. Human-only actions (approve, trust, waive,
// resume, git hooks) require an interactive terminal and the human passphrase,
// which unlocks the passphrase-sealed human key; agent shells are denied
// these commands by policy as well.
import { readFile } from "node:fs/promises"
import path from "node:path"
import {
  type Args,
  aliasReuseRatio,
  atomicWrite,
  BOOLEAN_FLAGS,
  brainstormPaths,
  buildPlan,
  candidateId,
  capabilityLoss,
  checkDrift,
  compileToCssVars,
  designPaths,
  exportBrief,
  Factory,
  factoryLayout,
  factorySummary,
  findOneOffs,
  flag,
  formatDiagnostics,
  gateRunner,
  git,
  HookEngine,
  harvestPaths,
  installServer,
  LENSES,
  LspManager,
  listBrainstormRuns,
  listRuns,
  loadEsConfig,
  loadHooks,
  loadInterview,
  parseArgs,
  parseRunId,
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
  researchOptions,
  researchTools,
  SlotLoop,
  scanSource,
  startRun as startBrainstorm,
  stateDir as userStateDir,
  validateTokens,
  verifyAuditChain,
  verifyBrief,
  writeArtifacts,
  writeProfile,
} from "@heretek-ai/es-core"
import { gatesRun, installGitHooks } from "./gates.ts"
import { DRIVERS, LOG_LEVELS, logLevel, presentEvent, runHeadless } from "./headless.ts"
import {
  approve,
  configSet,
  type HumanContext,
  rebaselineControl,
  recordPr,
  reseal,
  resume,
  retract,
  trust,
  waive,
} from "./human.ts"
import { auditCommand, auditDismiss, auditShow, scoutCommand, scoutShow } from "./jobs.ts"
import { keySeal, keyStatus } from "./key.ts"
import { serveStdio } from "./mcp.ts"
import { runsCommand, statusCommand } from "./status.ts"
import { type ConfirmIO, confirmHuman, NotInteractive, terminalIO } from "./tty.ts"
import { VERSION } from "./version.ts"
import { terminalWatchIO, type WatchIO, watchCommand } from "./watch.ts"

export { VERSION }

const HELP = `es ${VERSION} — Epistemic Swarm build factory

Usage: es [--cwd <dir> | --run <run id>] <command>

Factory
  status [--json]               Is the run working, waiting, stuck or done? (headline, seats, research progress)
  runs [--all] [--json]         Recent runs across your projects (* marks this one)
  watch [--interval S]          es status, redrawn every S seconds (default 2); q quits   [terminal]
  factory begin                 Start a run (normally done by /grill)
  factory run --headless        Drive the factory through a harness CLI, emitting JSON lines
        [--driver opencode] [--max-turns N] [--log-level quiet|info|debug]
  factory stop [reason]         Create .factory/STOP (kill switch)
  factory resume                Clear a halt            [human, TTY]
        [--accept-drift] [--raise-ceiling USD] [--extend-runtime]
  factory pr <url>              Record a release PR opened by hand   [human, TTY]

Checkpoints and exceptions
  approve <frontier|spec>       Approve a checkpoint (shows hashes; asks for the passphrase)   [human, TTY]
  trust [--show]                Approve this project's gate commands by hash   [human, TTY]
  rebaseline                    Accept hand edits to pinned control files (gates.json, config.json)   [human, TTY]
  reseal [--sign]               Verify engine sidecars (re-sign reviewed files)   [human, TTY]
  waive <rule> --reason "…" [--files <glob>] [--expires 7d] [--id <name>]   [human, TTY]
  key seal                      Create the passphrase-sealed human key   [human, TTY]
  key status                    Show the human key fingerprint

Gates
  gates run [--full] [--staged] [--base <ref>] [--json] [files…]
  gates install-git [--uninstall]   Opt-in pre-commit/pre-push gates   [human, TTY]

Other
  hooks                         Hook bridge status, trust and per-harness capability loss
  research search <query>       Search with the configured provider
  research fetch <url>          Fetch and cache a source (prints its sha256)
  research audit [file] [--prune]  Epistemic audit of a research report
  research export [--out <file>]   Signed research brief (.factory/research/brief.pcrb.json)   [human, TTY]
  research verify-brief <file> [--allow-unverifiable]  Check a brief's sources, manifest, signature, quotes
  research retract <sha256> --event retracted|revised [--note "…"]   Degrade claims citing a source   [human, TTY]
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
  config set <key> <value> [--global]   Set one key (schema-validated)   [human, TTY]
  lsp [status]                  Language servers and how each resolves
  lsp diagnostics <file>        Diagnostics for one file
  lsp install <server>          Pinned, checksummed install   [human, TTY]
  audit <phase id | path>       Code audit by the auditor pair, driven headlessly   [human]
        [--max-usd N] [--open-only] [--max-turns N] [--driver opencode]
  audit show [id]               Code audits in this run and their reports
  audit dismiss <id> --reason "…"   Stop an audit from blocking   [human, TTY]
  audit verify                  Verify the hash-chained audit log
  scout "<feature>"             Find and vet open-source candidates, headlessly   [human]
        [--max-usd N] [--max-turns N]
  scout show [--json]           The scout's ranked verdicts
  mcp                           Serve the factory tools over MCP (stdio)
  version
`

/**
 * Usage for one command: its lines (and their continuation lines) from HELP,
 * or the full HELP for an unknown or absent command.
 */
export function commandHelp(command: string | undefined): string {
  if (!command) return HELP
  const lines = HELP.split("\n")
  const picked: string[] = []
  const head = new RegExp(`^  ${command.replace(/[^\w-]/g, "")}(\\s|$)`)
  for (let i = 0; i < lines.length; i++) {
    if (!head.test(lines[i]!)) continue
    picked.push(lines[i]!)
    while (lines[i + 1]?.startsWith("        ")) picked.push(lines[++i]!)
  }
  return picked.length
    ? `Usage: es ${command} … (es ${VERSION})\n${picked.join("\n")}\n\nAll commands: es --help`
    : HELP
}

export interface MainIO {
  readonly print: (text: string) => void
  readonly confirm: ConfirmIO
  readonly cwd: string
  readonly stateDir?: string
  /** The terminal `es watch` draws on (absent: not a terminal). */
  readonly terminal?: WatchIO
}

async function projectRoot(cwd: string): Promise<string> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"], { allowFail: true })
  return top.code === 0 ? top.stdout.trim() : cwd
}

export async function main(argv: readonly string[], io: MainIO): Promise<number> {
  const args = parseArgs(argv, BOOLEAN_FLAGS)
  const [command, sub, ...rest] = args.positionals
  // `--help` is side-effect free on every subcommand: print usage without
  // minting runs, writing files, or touching the factory state. Any value
  // (`--help=x`) still means help, never "run the command".
  if (args.flags.help !== undefined) {
    io.print(commandHelp(command))
    return 0
  }
  const userState = io.stateDir ?? userStateDir()
  // `--run <id>` is `--cwd <that run's project>`, looked up in the run index.
  const runId = flag(args, "run")
  const indexed = runId ? (await listRuns(userState)).find((entry) => entry.runId === runId) : undefined
  if (runId && !indexed) {
    io.print(`Unknown run ${runId}. \`es runs\` lists the runs this machine has seen.`)
    return 2
  }
  const root = indexed?.root ?? (await projectRoot(path.resolve(io.cwd, flag(args, "cwd") ?? ".")))
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
        return await statusCommand({ root, stateDir: userState, print: io.print }, args)
      case "runs":
        return await runsCommand({ root, stateDir: userState, print: io.print }, args)
      case "watch":
        return await watchCommand(
          { root, stateDir: userState, print: io.print },
          args,
          io.terminal ?? { interactive: false, write: io.print, onKey: () => () => {} },
        )
      case "approve":
        return await approve(context, subArgs(1))
      case "trust":
        return await trust(context, subArgs(1))
      case "rebaseline":
        return await rebaselineControl(context)
      case "reseal":
        return await reseal(context, args.flags.sign === true)
      case "waive":
        return await waive(context, subArgs(1))
      case "key": {
        if (sub === "seal") return await keySeal(io)
        if (sub === "status") return await keyStatus(io)
        io.print("Usage: es key seal | status")
        return 2
      }
      case "research": {
        if (sub === "retract") return await retract(context, subArgs(2))
        if (sub === "export") {
          const out = flag(args, "out")
          const outFile = out ? path.resolve(io.cwd, out) : undefined
          const signer = await confirmHuman(
            io.confirm,
            "Export research brief",
            [
              `Signs the brief with the human key (${outFile ? path.relative(root, outFile) : ".factory/research/brief.pcrb.json"}).`,
            ],
            io.stateDir,
          )
          if (!signer) {
            io.print("Cancelled; nothing was exported.")
            return 1
          }
          const { file, brief } = await exportBrief(root, {
            signer,
            ...(outFile ? { out: outFile } : {}),
            ...(io.stateDir ? { stateDir: io.stateDir } : {}),
          })
          const witnessed = brief.claims.filter((claim) => claim.witness.ok).length
          io.print(
            [
              `Exported ${path.relative(root, file) || file}`,
              `Claims: ${brief.claims.length} (${witnessed} witnessed), ranked strongest first`,
              `Sources: ${Object.keys(brief.sources).length} bundled · signed by key ${brief.signature.keyId}`,
            ].join("\n"),
          )
          return 0
        }
        if (sub === "verify-brief") {
          if (!rest[0]) {
            io.print("Usage: es research verify-brief <file> [--allow-unverifiable]")
            return 2
          }
          let raw: unknown
          try {
            raw = JSON.parse(await readFile(path.resolve(io.cwd, rest[0]), "utf8"))
          } catch (error) {
            io.print(`Cannot read ${rest[0]}: ${error instanceof Error ? error.message : String(error)}`)
            return 2
          }
          const result = await verifyBrief(raw, {
            ...(io.stateDir ? { stateDir: io.stateDir } : {}),
            allowUnverifiable: args.flags["allow-unverifiable"] === true,
          })
          io.print(
            [
              `${result.ok ? "Brief OK" : "Brief FAILED"}: source identity ${result.checks.sourceIdentity}, manifest ${result.checks.manifest}, signature ${result.checks.signature}, quotes ${result.checks.quotes}`,
              `${result.stats.claims} claims, ${result.stats.sources} sources, ${result.stats.quotesVerified} quotes verified, ${result.stats.quotesFailed} not witnessed`,
              ...result.failures
                .slice(0, 25)
                .map(
                  (item) => `  ✗ ${item.check}${item.member ? ` ${item.member.slice(0, 22)}` : ""}: ${item.message}`,
                ),
            ].join("\n"),
          )
          return result.ok ? 0 : 1
        }
        const config = await loadEsConfig(root)
          .then((loaded) => loaded.config)
          .catch(() => undefined)
        const tools = researchTools({
          root,
          ...(config ? researchOptions(config) : {}),
          stateDir: io.stateDir,
          policy: () => Promise.resolve({ root, ...(io.stateDir ? { stateDir: io.stateDir } : {}) }),
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
        io.print(
          "Usage: es research search <query> | fetch <url> | audit [file] [--prune] | export [--out <file>] | verify-brief <file> | retract <sha256> --event retracted|revised",
        )
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
          let run: string
          try {
            run = parseRunId(rest[0])
          } catch (error) {
            io.print(error instanceof Error ? error.message : String(error))
            return 2
          }
          const result = await readBrainstormResult(root, run).catch(() => undefined)
          if (result) {
            io.print(args.flags.json === true ? JSON.stringify(result, null, 2) : renderBrainstorm(result))
            return 0
          }
          const plan = await readBrainstormPlan(root, run).catch(() => undefined)
          if (plan) {
            const ideas = await readBrainstormIdeas(root, run).catch(() => [])
            const scores = await readBrainstormScores(root, run).catch(() => [])
            const survivors = ideas.filter((idea) => !idea.duplicateOf)
            io.print(
              [
                `Brainstorm in progress (run "${run}"): "${plan.brief.idea}"`,
                `Lenses: ${plan.lenses.join(", ")}`,
                `Ideas: ${survivors.length} surviving (${ideas.length - survivors.length} duplicate(s)) · scored ${scores.length}/${survivors.length}`,
                `Coverage: ${plan.lenses.map((lens) => `${lens} ${survivors.filter((idea) => idea.lens === lens).length}`).join(" · ")}`,
              ].join("\n"),
            )
            return 0
          }
          const runs = await listBrainstormRuns(root).catch(() => [] as string[])
          io.print(
            runs.length
              ? `No brainstorm run "${run}" in ${paths.dir}. Runs: ${runs.join(", ")}.`
              : `No brainstorm in ${paths.dir}. Start one with /brainstorm in OpenCode, or \`es brainstorm plan "<idea>"\`.`,
          )
          return 1
        }
        io.print('Usage: es brainstorm plan "<idea>" | show [run] [--json] | lenses')
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
            // A human at the CLI may scan outside the project (never the state dir).
            const profile = await scanSource(root, id, source, { allowOutside: true })
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
          let run: string
          try {
            run = parseRunId(rest[0])
          } catch (error) {
            io.print(error instanceof Error ? error.message : String(error))
            return 2
          }
          const runPaths = harvestPaths(root, run)
          const result = await readHarvestResult(root, run).catch(() => undefined)
          if (result) {
            const report = await readFile(runPaths.report, "utf8").catch(() => undefined)
            io.print(
              args.flags.json === true ? JSON.stringify(result, null, 2) : (report ?? `${runPaths.report} is missing`),
            )
            return 0
          }
          const plan = await readHarvestPlan(root, run).catch(() => undefined)
          if (plan) {
            const profiles = await readHarvestProfiles(root, run).catch(() => [])
            const scanned = new Set(profiles.map((profile) => profile.id))
            io.print(
              [
                `Darkharvest in progress (run "${run}"): ${plan.objective}`,
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
        io.print("Usage: es harvest show [run] [--json] | scan <source>")
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
        if (sub === "set") return await configSet(context, subArgs(2))
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
        io.print("Usage: es config show | set <key> <value> [--global]")
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
            if (!(await confirmHuman(io.confirm, `Install the ${id} language server`, lines, io.stateDir))) return 1
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
        if (sub === "verify") {
          const result = await verifyAuditChain(root)
          io.print(
            result.valid ? `Audit log OK (${result.entries.length} entries).` : `Audit log INVALID: ${result.error}`,
          )
          return result.valid ? 0 : 1
        }
        if (sub === "show") return await auditShow(context, subArgs(2))
        if (sub === "dismiss") return await auditDismiss(context, subArgs(2))
        return await auditCommand(context, subArgs(1))
      }
      case "scout":
        if (sub === "show") return await scoutShow(context, subArgs(2))
        return await scoutCommand(context, subArgs(1))
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
        if (sub === "status") return await statusCommand({ root, stateDir: userState, print: io.print }, args)
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
          const level = logLevel(args)
          if (!level) {
            io.print(`Unknown --log-level. Use one of: ${LOG_LEVELS.join(", ")} (default info).`)
            return 2
          }
          let code = 0
          for await (const event of runHeadless({
            root,
            driver,
            ...(flag(args, "max-turns") ? { maxTurns: Number(flag(args, "max-turns")) } : {}),
            ...(io.stateDir ? { stateDir: io.stateDir } : {}),
          })) {
            const shown = presentEvent(event, level)
            if (shown !== undefined) io.print(JSON.stringify(shown))
            if (["error", "halted", "stalled", "turn-cap"].includes(event.type)) code = 1
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
    terminal: terminalWatchIO(),
  })
  process.exit(code)
}
