// Renders each TUI panel headlessly with OpenTUI's test renderer (run by
// panels.test.ts in a subprocess with the Solid transform preloaded) and
// prints the captured frames as JSON.
import { testRender } from "@opentui/solid"
import { PANEL_COMPONENTS } from "../../src/panels.tsx"

const data: Record<string, any> = {
  factoryState: {
    stage: "BUILD",
    runId: "run-7",
    activePhase: "p2",
    spend: { usd: 1.25, estimated: true, ceilingUSD: 5 },
    phases: [
      { id: "p1", title: "Parser", status: "done", failures: 0, qa: {} },
      { id: "p2", title: "Gate", status: "building", failures: 1, qa: {} },
    ],
    pending: [],
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

const listeners = new Set<() => void>()
const call = (method: string) => Promise.resolve(structuredClone(data[method]))
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const frames: Record<string, string> = {}
for (const [name, Panel] of Object.entries(PANEL_COMPONENTS)) {
  const setup = await testRender(() => <Panel call={call} subscribe={subscribe} />, { width: 100, height: 24 })
  frames[name] = await setup.waitForFrame((frame) => !frame.includes("Loading"), { timeout: 5_000 })
  if (name === "factory") {
    // A server change event refetches: the dashboard follows the run.
    data.factoryState.stage = "QA"
    for (const listener of listeners) listener()
    frames.factoryAfterChange = await setup.waitForFrame((frame) => frame.includes("Stage: QA"), { timeout: 5_000 })
  }
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
