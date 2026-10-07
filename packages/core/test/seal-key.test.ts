import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ensureEngineKey } from "../src/research/seal.ts"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "es-engine-key-"))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe("engine key creation", () => {
  test("creates once (0600) and returns the same key after", async () => {
    const first = await ensureEngineKey(dir)
    expect(first.length).toBe(32)
    expect(await ensureEngineKey(dir)).toEqual(first)
  })

  test("concurrent creators converge on one key", async () => {
    const keys = await Promise.all([ensureEngineKey(dir), ensureEngineKey(dir), ensureEngineKey(dir)])
    for (const key of keys) expect(key).toEqual(keys[0])
  })

  test("a planted symlink is refused, never followed (js/file-system-race)", async () => {
    const target = path.join(dir, "attacker-key")
    await writeFile(target, "x".repeat(32))
    await symlink(target, path.join(dir, "engine.key"))
    await expect(ensureEngineKey(dir)).rejects.toThrow()
    // The attacker's file was neither read as the key nor overwritten.
    expect(await Bun.file(target).text()).toBe("x".repeat(32))
  })

  test("a truncated key file is refused instead of used", async () => {
    await writeFile(path.join(dir, "engine.key"), "short")
    await expect(ensureEngineKey(dir)).rejects.toThrow("shorter than 32 bytes")
  })
})
