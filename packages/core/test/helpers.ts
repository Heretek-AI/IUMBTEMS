// Shared fixtures for factory tests: a real git repo, an isolated state dir,
// and artifacts that pass validation.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { run } from "../src/util/proc.ts"
import { stringifyFrontmatter } from "../src/util/yaml.ts"

export interface Fixture {
  readonly root: string
  readonly state: string
  cleanup(): Promise<void>
}

export async function gitRepo(prefix = "es-fx-"): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  const state = await mkdtemp(path.join(tmpdir(), `${prefix}state-`))
  const git = (...args: string[]) => run(["git", ...args], { cwd: root })
  await git("init", "-q", "-b", "main")
  await writeFile(path.join(root, "README.md"), "# fixture\n")
  await writeFile(path.join(root, ".gitignore"), ".factory/runtime/\n.factory/worktrees/\n.factory/runs/\n")
  await git("add", "-A")
  await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
  return {
    root,
    state,
    async cleanup() {
      await rm(root, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    },
  }
}

export const frontier = (overrides: Record<string, unknown> = {}) => ({
  version: "1.1",
  idea: "A greeting library",
  spendCeiling: { currency: "USD", maxAmount: 25 },
  settled: true,
  nodes: [{ id: "lang", question: "Language?", answer: "TypeScript", status: "settled" }],
  ...overrides,
})

export async function writeSpecs(root: string, phases: string[]) {
  await mkdir(path.join(root, ".factory/specs"), { recursive: true })
  await writeFile(
    path.join(root, ".factory/roadmap.json"),
    JSON.stringify(
      { version: 1, title: "Greeting", phases: phases.map((id) => ({ id, title: `Phase ${id}` })) },
      null,
      2,
    ),
  )
  for (const id of phases) await writeGoal(root, id)
}

export async function writeGoal(root: string, id: string, extra = "") {
  await mkdir(path.join(root, ".factory/specs", id), { recursive: true })
  await writeFile(
    path.join(root, ".factory/specs", id, "GOAL.md"),
    stringifyFrontmatter(
      {
        phase: id,
        title: `Phase ${id}`,
        acceptance: [{ kind: "file", id: "impl", description: "implementation exists", path: `src/${id}.ts` }],
      },
      `Implement ${id} as a vertical slice.${extra}\n`,
    ),
  )
}

/** A research report whose single claim cites a cached source verbatim. */
export async function writeReport(root: string, stateDir?: string) {
  const { SourceCache, researchSourcesDir } = await import("../src/research/index.ts")
  const cache = new SourceCache(researchSourcesDir(root), stateDir)
  const source = await cache.put({
    url: "https://example.test/greeting",
    text: "Greeting libraries usually expose a single greet function.",
    provider: "fetch",
  })
  await mkdir(path.join(root, ".factory/research"), { recursive: true })
  await writeFile(
    path.join(root, ".factory/research/REPORT.md"),
    `# Research\n\n- A greet function is the conventional API [VERIFIED: sha256:${source.meta.sha256} "expose a single greet function"]\n`,
  )
}
