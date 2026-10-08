// Renders each TUI panel headlessly with OpenTUI's test renderer (run by
// panels.test.ts in a subprocess with the Solid transform preloaded) and
// prints the captured frames as JSON.
import { testRender } from "@opentui/solid"
import { FactoryFooter, PANEL_COMPONENTS } from "../../src/panels.tsx"

const data: Record<string, any> = {
  factoryState: {
    stage: "BUILD",
    runId: "run-7",
    activePhase: "p2",
    headline: "Building p2 is running: es-programmer last ran edit 4s ago.",
    header: "run run-7 · BUILD · /work/demo · updated 4s ago",
    seats: ["es-programmer  running  edit 4s ago  ses_prog"],
    events: ["02:10:00  agent:factory  build.start"],
    spend: { usd: 1.25, estimated: true, ceilingUSD: 5 },
    phases: [
      { id: "p1", title: "Parser", status: "done", failures: 0, qa: {} },
      { id: "p2", title: "Gate", status: "building", failures: 1, qa: {} },
    ],
    pending: [],
    tree: { round: 3, total: 9, settled: 6, open: 1, deferred: 2, facts: 1, frontier: 1 },
    audits: [
      {
        id: "audit-01",
        target: "path src",
        status: "failed",
        round: 1,
        thesis: "pass",
        antithesis: "fail",
        tiebreak: "fail",
      },
    ],
  },
  lspState: {
    enabled: true,
    servers: [
      { id: "typescript", extensions: [".ts", ".tsx"], available: true, command: "tsc --lsp", running: 1 },
      { id: "pyright", extensions: [".py"], available: false, command: "unavailable", running: 0 },
    ],
    diagnostics: [],
  },
  hooksState: {
    handlers: 3,
    projectHandlers: 1,
    trusted: false,
    projectLines: ["PreToolUse Bash → ./hooks/check.sh"],
    diagnostics: [],
    recent: [],
    loss: [{ event: "Stop", handler: "command", support: "advisory", reason: "emulated after the turn" }],
  },
  brainstormState: {
    active: true,
    brief: "A faster test runner",
    lenses: ["inversion", "scamper"],
    ideas: 4,
    duplicates: 1,
    scored: 4,
    coverage: { inversion: 2, scamper: 2 },
    shortlist: [
      { id: "b001", total: 17, outlier: false, title: "Run only affected tests" },
      { id: "b004", total: 11, outlier: true, title: "No tests at all" },
    ],
    gaps: [],
    complete: true,
  },
}

// RESEARCH with no phases yet (#57): no dangling "Phases:" header; seats and research progress instead.
const research = {
  stage: "RESEARCH",
  runId: "run-8",
  headline: "Research is running: es-research-alpha last ran es_research_fetch 12s ago.",
  header: "run run-8 · RESEARCH · /work/demo · updated 12s ago",
  seats: ["es-research-alpha  running  es_research_fetch 12s ago  ses_alpha"],
  research: "10 sources (newest 1m ago) · alpha.md 4.1 KB (2m ago) · beta.md — · REPORT.md — · coverage not checked",
  events: ["01:58:40  human:john  stage.research"],
  spend: { usd: 6.41, estimated: true, ceilingUSD: 500 },
  phases: [],
  pending: [],
  audits: [],
  tree: { round: 4, total: 24, settled: 21, open: 0, deferred: 3, facts: 3, frontier: 0 },
}

const listeners = new Set<() => void>()
const call = (method: string) => Promise.resolve(structuredClone(data[method]))
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const frames: Record<string, string> = {}
for (const [name, Panel] of Object.entries(PANEL_COMPONENTS)) {
  const setup = await testRender(() => <Panel call={call} subscribe={subscribe} />, { width: 110, height: 40 })
  frames[name] = await setup.waitForFrame((frame) => !frame.includes("Loading"), { timeout: 5_000 })
  if (name === "factory") {
    // A server change event refetches: the dashboard follows the run.
    data.factoryState.header = "run run-7 · QA · /work/demo · updated 1s ago"
    for (const listener of listeners) listener()
    frames.factoryAfterChange = await setup.waitForFrame((frame) => frame.includes("· QA ·"), { timeout: 5_000 })
  }
  setup.renderer.destroy()
}
{
  const setup = await testRender(
    () => <PANEL_COMPONENTS.factory call={() => Promise.resolve(structuredClone(research))} subscribe={subscribe} />,
    { width: 140, height: 40 },
  )
  frames.research = await setup.waitForFrame((frame) => frame.includes("Research:"), { timeout: 5_000 })
  setup.renderer.destroy()
}

// The panel's keys go through the host's keymap layer; Esc/q closes, f toggles fullscreen.
{
  const bound: Array<{ title: string; bind: string; run: () => void }> = []
  const handled: string[] = []
  const setup = await testRender(
    () => (
      <PANEL_COMPONENTS.factory
        call={call}
        subscribe={subscribe}
        panel={{ close: () => handled.push("close"), toggleFullscreen: () => handled.push("fullscreen") }}
        layer={(factory) => bound.push(...factory().commands)}
      />
    ),
    { width: 110, height: 40 },
  )
  await setup.waitForFrame((frame) => !frame.includes("Loading"), { timeout: 5_000 })
  for (const command of bound) if (command.title !== "refresh") command.run()
  frames.keys = JSON.stringify({ binds: bound.map((command) => command.bind), handled })
  setup.renderer.destroy()
}

// The prompt-footer indicator: the server's footer line, hidden without one.
{
  const setup = await testRender(
    () => (
      <FactoryFooter
        call={() => Promise.resolve({ footer: "ES · RESEARCH · es-research-alpha running · 12s" })}
        subscribe={subscribe}
      />
    ),
    { width: 80, height: 3 },
  )
  frames.footer = await setup.waitForFrame((frame) => frame.includes("ES ·"), { timeout: 5_000 })
  setup.renderer.destroy()
}

// An RPC failure renders as text instead of throwing.
const failing = await testRender(
  () => <PANEL_COMPONENTS.lsp call={() => Promise.reject(new Error("server gone"))} subscribe={subscribe} />,
  { width: 100, height: 10 },
)
frames.failure = await failing.waitForFrame((frame) => frame.includes("Could not load"), { timeout: 5_000 })
failing.renderer.destroy()

process.stdout.write(`${JSON.stringify(frames)}\n`)
process.exit(0)
