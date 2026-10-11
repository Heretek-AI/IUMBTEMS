// Human key lifecycle (#119): destroy() ends signing.
import { expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { hasHumanKey, HumanKeyError, sealHumanKey, unlockHumanKey } from "../src/approval/keystore.ts"
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
