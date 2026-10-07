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

  expect(frames.factory).toContain("Stage: BUILD · run-7")
  expect(frames.factory).toContain("Spend: $1.25 / $5 (estimated)")
  expect(frames.factory).toContain("▶ p2 · building · failures 1")
  expect(frames.factory).toContain("Design tree (round 3): 6 settled · 1 open · 2 deferred (1 for research)")
  expect(frames.factory).toContain("audit-01 · path src · failed r1 · t:pass a:fail x:fail")
  expect(frames.factoryAfterChange).toContain("Stage: QA")

  expect(frames.lsp).toContain("● typescript [.ts .tsx] · 1 running")
  expect(frames.lsp).toContain("○ pyright [.py] — not installed")

  expect(frames.hooks).toContain("1 from the project · NOT trusted")
  expect(frames.hooks).toContain("! Stop · command — advisory: emulated after the turn")

  expect(frames.brainstorm).toContain("Coverage: inversion 2 · scamper 2")
  expect(frames.brainstorm).toContain("◇ b004 (11/20) — No tests at all (forced outlier)")

  expect(frames.failure).toContain("Could not load: server gone")
}, 60_000)
