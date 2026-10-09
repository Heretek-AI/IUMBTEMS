// Human key lifecycle (#119): destroy() ends signing.
import { expect, test } from "bun:test"
import { HumanKeyError, sealHumanKey, unlockHumanKey } from "../src/approval/keystore.ts"
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
