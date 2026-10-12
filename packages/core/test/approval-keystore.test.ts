// Human key lifecycle (#119): destroy() ends signing.
import { expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  auditEngineResign,
  HumanKeyError,
  hasHumanKey,
  resetHumanKey,
  sealHumanKey,
  unlockHumanKey,
} from "../src/approval/keystore.ts"
import { recentAuditEntries } from "../src/audit/chain.ts"
import { gitRepo } from "./helpers.ts"

const PASSPHRASE = "test-passphrase-1234"

test("destroy zeroes the key and further signs throw", async () => {
  const fx = await gitRepo()
  try {
    await sealHumanKey(PASSPHRASE, fx.state)
    const signer = await unlockHumanKey(PASSPHRASE, fx.state)
    expect(signer.sign({ hello: "world" }).alg).toBe("ed25519")
    signer.destroy()
    expect(() => signer.sign({ hello: "world" })).toThrow(HumanKeyError)
  } finally {
    fx.cleanup()
  }
})

test("hasHumanKey requires both halves: a lone human.key is a brick, not a key (#213)", async () => {
  const fx = await gitRepo()
  try {
    expect(await hasHumanKey(fx.state)).toBe(false)
    await writeFile(path.join(fx.state, "human.key"), '{"version":1}\n')
    expect(await hasHumanKey(fx.state)).toBe(false)
  } finally {
    fx.cleanup()
  }
})

test("#354: reset replaces only the human key without touching engine.key", async () => {
  const fx = await gitRepo()
  try {
    await sealHumanKey(PASSPHRASE, fx.state)
    const before = await readFile(path.join(fx.state, "human.key"), "utf8")
    await writeFile(path.join(fx.state, "engine.key"), Buffer.alloc(32, 7))
    const engineBefore = await readFile(path.join(fx.state, "engine.key"))
    const { keyId, mustRerecord } = await resetHumanKey("brand-new-passphrase-99", fx.state)
    expect(keyId).toMatch(/^[0-9a-f]{16}$/)
    expect(mustRerecord).toMatch(/recorded again/)
    expect(await readFile(path.join(fx.state, "human.key"), "utf8")).not.toBe(before)
    expect(await readFile(path.join(fx.state, "engine.key"))).toEqual(engineBefore)
    expect(await hasHumanKey(fx.state)).toBe(true)
    const signer = await unlockHumanKey("brand-new-passphrase-99", fx.state)
    expect(signer.keyId).toBe(keyId)
    signer.destroy()
  } finally {
    fx.cleanup()
  }
})

test("#354: seal refuses when a key exists and points at es key reset", async () => {
  const fx = await gitRepo()
  try {
    await sealHumanKey(PASSPHRASE, fx.state)
    const error = await sealHumanKey(PASSPHRASE, fx.state).then(
      () => "no-throw",
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(HumanKeyError)
    expect((error as Error).message).toContain("es key reset")
  } finally {
    fx.cleanup()
  }
})

test("#354: a re-sign is visible in the audit log", async () => {
  const fx = await gitRepo()
  try {
    await auditEngineResign(fx.root, [".factory/runtime/state.json"], "human:tester")
    const entries = await recentAuditEntries(fx.root, 5)
    const resign = entries.find((entry) => entry.action === "engine.resign")
    expect(resign?.payload).toMatchObject({ files: [".factory/runtime/state.json"] })
  } finally {
    fx.cleanup()
  }
})
