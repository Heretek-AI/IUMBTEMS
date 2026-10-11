// Release base-branch safety against a local bare remote (issue #202):
// `Factory.release` pushes the run's `factory/...` integration branch only —
// the base branch SHA is identical on disk and on the remote afterwards — and
// a run with no PR opener refuses before anything is pushed.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { type HumanSigner, recordApproval, sealHumanKey, unlockHumanKey } from "../src/approval/index.ts"
import { Factory, type GateRequest, type GateRunLike, type PrRequest } from "../src/factory/index.ts"
import { run } from "../src/util/proc.ts"
import * as Git from "../src/worktree/index.ts"
import { type Fixture, frontier, gitRepo, writeReport, writeSpecs } from "./helpers.ts"

const PASSPHRASE = "test-passphrase-release-202"
const green: GateRunLike = { passed: true, findings: [], summary: "green" }

let fx: Fixture
let signer: HumanSigner
let bare: string
/** Every request the pushing opener received (it pushes, then reports a fake URL). */
let opened: PrRequest[]

const gates = async (_request: GateRequest): Promise<GateRunLike> => green

const pushingOpener = (root: string) => ({
  id: "local-push",
  available: async () => true,
  open: async (request: PrRequest) => {
    opened.push(request)
    // The same refspec `ghPrOpener` uses (`branch:branch`): only the run's
    // branch travels; the base branch is never named.
    await Git.git(root, ["push", "origin", `${request.branch}:${request.branch}`])
    return { url: "https://example.test/pr/local-1" }
  },
})

const make = (pr?: ConstructorParameters<typeof Factory>[1]["pr"]) =>
  new Factory(fx.root, { gates, ...(pr === undefined ? {} : { pr }), stateDir: fx.state })

const sh = async (cwd: string, ...args: string[]) => {
  const result = await run(["git", ...args], { cwd })
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout.trim()
}

/** `ref -> sha` for every ref on the remote, via the local transport (no network). */
const remoteRefs = async (): Promise<Map<string, string>> => {
  const out = await sh(fx.root, "ls-remote", bare)
  const refs = new Map<string, string>()
  for (const line of out.split("\n").filter(Boolean)) {
    const [sha, ref] = line.split("\t")
    refs.set(ref!, sha!)
  }
  return refs
}

async function toRelease(factory: Factory) {
  await factory.begin("human:tester")
  await factory.writeFrontier("grill", frontier())
  await recordApproval(fx.root, { stage: "frontier", channel: "cli", approvedBy: "tester", signer })
  await factory.beginResearch("human:tester")
  await writeReport(fx.root, fx.state)
  await factory.completeResearch("factory")
  await writeSpecs(fx.root, ["alpha"])
  await recordApproval(fx.root, { stage: "spec", channel: "cli", approvedBy: "tester", signer })
  await factory.startBuild("factory")
  const dir = (await factory.activeWorktree())!
  await mkdir(path.join(dir, "src"), { recursive: true })
  await mkdir(path.join(dir, "test"), { recursive: true })
  await writeFile(path.join(dir, "test/alpha.test.ts"), 'test("alpha", () => {})\n')
  await factory.recordGateRun("es-programmer", {
    passed: false,
    findings: [],
    summary: "red",
    failedTests: ["test/alpha.test.ts"],
  })
  await writeFile(path.join(dir, "src/alpha.ts"), "export const alpha = 1\n")
  await factory.complete("es-programmer")
  await factory.qaVerdict("es-qa-functional", "pass", "criteria met")
  await factory.qaVerdict("es-qa-adversarial", "pass", "nothing broke")
  const state = (await factory.read())!
  expect(state.stage).toBe("RELEASE")
  return state
}

beforeEach(async () => {
  fx = await gitRepo("es-release-")
  await sealHumanKey(PASSPHRASE, fx.state)
  signer = await unlockHumanKey(PASSPHRASE, fx.state)
  opened = []
  // A local bare remote stands in for GitHub: file transport, no network.
  bare = await mkdtemp(path.join(tmpdir(), "es-release-bare-"))
  await sh(fx.root, "init", "-q", "--bare", bare)
  await sh(fx.root, "remote", "add", "origin", bare)
  await sh(fx.root, "push", "-q", "origin", "main")
})
afterEach(async () => {
  await fx.cleanup()
  await rm(bare, { recursive: true, force: true })
})

describe("release against a local bare remote", () => {
  test("release pushes factory/... only; the base SHA is unchanged everywhere", async () => {
    const factory = make(pushingOpener(fx.root))
    const before = await toRelease(factory)
    expect(before.runBranch).toMatch(/^factory\//)
    expect(before.runBranch).not.toBe(before.baseBranch)

    const baseBefore = await Git.revParse(fx.root, "main")
    const bareBaseBefore = await Git.revParse(bare, "main")

    const done = await factory.release("factory")
    expect(done.stage).toBe("DONE")
    expect(done.release?.prUrl).toBe("https://example.test/pr/local-1")
    expect(opened).toHaveLength(1)
    expect(opened[0]?.branch).toBe(done.runBranch)
    expect(opened[0]?.branch).toMatch(/^factory\//)
    expect(opened[0]?.base).toBe("main")

    // The remote gained exactly the run branch; nothing else moved.
    const refs = await remoteRefs()
    expect([...refs.keys()].sort()).toEqual(["refs/heads/main", `refs/heads/${done.runBranch}`].sort())
    expect(refs.get("refs/heads/main")).toBe(bareBaseBefore)
    expect(refs.get(`refs/heads/${done.runBranch}`)).toBe(await Git.revParse(fx.root, done.runBranch!))

    // The base branch is byte-identical on disk and on the remote.
    expect(await Git.revParse(fx.root, "main")).toBe(baseBefore)
    expect(await Git.revParse(bare, "main")).toBe(baseBefore)
  })

  test("release with no PR opener refuses before anything is pushed", async () => {
    const factory = make(undefined)
    await toRelease(factory)
    const refsBefore = await remoteRefs()
    await expect(factory.release("factory")).rejects.toThrow("no PR opener")
    expect((await factory.read())?.stage).toBe("RELEASE")
    expect(await remoteRefs()).toEqual(refsBefore)
  })
})
