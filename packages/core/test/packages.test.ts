// One source of truth for the workspace package lists (#102): scripts/
// packages.ts reads packages/*/package.json instead of hard-coded lists.
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { releasePackages, workspacePackages } from "../../../scripts/packages.ts"

const manifest = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "@heretek-ai/fixture", version: "0.0.0", ...extra })

async function fixture(pkgs: Record<string, Record<string, unknown>>) {
  const root = await mkdtemp(path.join(tmpdir(), "es-packages-"))
  for (const [dir, extra] of Object.entries(pkgs)) {
    await mkdir(path.join(root, "packages", dir), { recursive: true })
    await writeFile(path.join(root, "packages", dir, "package.json"), manifest(extra))
  }
  return root
}

describe("workspace packages", () => {
  test("lists every package dir with its manifest facts", async () => {
    const root = await fixture({
      core: { name: "@heretek-ai/es-core", esRelease: { order: 1 } },
      zz: {},
      private: { name: "@heretek-ai/p", private: true },
    })
    try {
      expect((await workspacePackages(root)).map((pkg) => pkg.dir).sort()).toEqual(["core", "private", "zz"])
      const core = (await workspacePackages(root)).find((pkg) => pkg.dir === "core")!
      expect(core).toMatchObject({ name: "@heretek-ai/es-core", private: false, order: 1 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("release packages are unpublished-by-order: private unset plus esRelease.order", async () => {
    const root = await fixture({
      opencode: { name: "@heretek-ai/epistemic-swarm", esRelease: { order: 3 } },
      core: { name: "@heretek-ai/es-core", esRelease: { order: 1 } },
      cli: { name: "@heretek-ai/es-cli", esRelease: { order: 2 } },
      testkit: { name: "@heretek-ai/es-testkit", private: true },
      secret: { name: "@heretek-ai/secret", private: true, esRelease: { order: 4 } },
    })
    try {
      expect((await releasePackages(root)).map((pkg) => pkg.dir)).toEqual(["core", "cli", "opencode"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a public package without esRelease.order fails loudly", async () => {
    const root = await fixture({
      core: { name: "@heretek-ai/es-core", esRelease: { order: 1 } },
      unordered: { name: "@heretek-ai/unordered" },
    })
    try {
      await expect(releasePackages(root)).rejects.toThrow("has no esRelease.order")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("the real repo releases core, cli and the plugin in dependency order", async () => {
    const root = path.resolve(import.meta.dir, "../../..")
    expect((await releasePackages(root)).map((pkg) => pkg.dir)).toEqual(["core", "cli", "opencode"])
    expect((await workspacePackages(root)).map((pkg) => pkg.dir).sort()).toEqual(
      expect.arrayContaining(["cli", "core", "opencode", "testkit"]),
    )
  })
})
