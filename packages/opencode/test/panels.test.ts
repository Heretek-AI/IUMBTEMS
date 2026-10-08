// The four TUI panels rendered for real (OpenTUI's headless test renderer, the
// reactive Solid build), in a subprocess so the Solid transform preload stays
// out of the real-host tests that share this process.
import { expect, test } from "bun:test"
import path from "node:path"

const pkg = path.resolve(import.meta.dir, "..")

test("each panel renders its state, follows server changes and shows failures", async () => {
  const proc = Bun.spawn(
    ["bun", "--conditions=browser", "--preload", "@opentui/solid/preload", "test/render/panels.tsx"],
    { cwd: pkg, stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" })
  const frames = JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<string, string>

  expect(frames.factory).toContain("Building p2 is running: es-programmer last ran edit 4s ago.")
  expect(frames.factory).toContain("run run-7 · BUILD · /work/demo · updated 4s ago")
  expect(frames.factory).toContain("Spend: $1.25 / $5 (estimated)")
  expect(frames.factory).toContain("▶ p2 Gate · building · failures 1")
  expect(frames.factory).toContain("Design tree (round 3): 6 settled · 1 open · 2 deferred (1 for research)")
  expect(frames.factory).toContain("audit-01 · path src · failed r1 · t:pass a:fail x:fail")
  expect(frames.factory).toContain("es-programmer  running  edit 4s ago  ses_prog")
  expect(frames.factory).toContain("02:10:00  agent:factory  build.start")
  expect(frames.factory).toContain("esc/q close · f fullscreen · r refresh")
  expect(frames.factoryAfterChange).toContain("run run-7 · QA · /work/demo")

  // RESEARCH (#57): the headline, seats and research progress; no dangling "Phases:" header.
  expect(frames.research).toContain("Research is running: es-research-alpha last ran es_research_fetch 12s ago.")
  expect(frames.research).toContain("es-research-alpha  running  es_research_fetch 12s ago  ses_alpha")
  expect(frames.research).toContain("Research: 10 sources (newest 1m ago) · alpha.md 4.1 KB (2m ago)")
  expect(frames.research).not.toContain("Phases:")

  // Keys go through the host keymap layer created inside the panel.
  expect(JSON.parse(frames.keys!)).toEqual({ binds: ["escape,q", "f", "r"], handled: ["close", "fullscreen"] })
  expect(frames.footer).toContain("ES · RESEARCH · es-research-alpha running · 12s")

  expect(frames.lsp).toContain("● typescript [.ts .tsx] · 1 running")
  expect(frames.lsp).toContain("○ pyright [.py] — not installed")

  expect(frames.hooks).toContain("1 from the project · NOT trusted")
  expect(frames.hooks).toContain("! Stop · command — advisory: emulated after the turn")

  expect(frames.brainstorm).toContain("Coverage: inversion 2 · scamper 2")
  expect(frames.brainstorm).toContain("◇ b004 (11/20) — No tests at all (forced outlier)")

  expect(frames.failure).toContain("Could not load: server gone")
}, 60_000)
