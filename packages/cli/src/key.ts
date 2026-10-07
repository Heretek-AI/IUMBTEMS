// `es key`: the passphrase-sealed human key (1.1.1). The private half never
// leaves the sealed file; the passphrase is typed with echo off, twice at
// seal time. Agents cannot seal (no TTY) and cannot unlock (no passphrase).
import { HumanKeyError, hasHumanKey, humanKeyId, sealHumanKey } from "@heretek-ai/es-core"
import type { MainIO } from "./main.ts"
import { NotInteractive } from "./tty.ts"

export async function keySeal(io: MainIO): Promise<number> {
  if (!io.confirm.interactive) throw new NotInteractive("es key seal")
  if (await hasHumanKey(io.stateDir)) {
    io.print(
      "This machine already has a human key; remove human.key and human.pub by hand to replace it, then re-record approvals.",
    )
    return 1
  }
  const first = await io.confirm.readSecret("Your Epistemic Swarm passphrase (at least 10 characters, empty cancels): ")
  if (!first) {
    io.print("Cancelled; no key was sealed.")
    return 1
  }
  const second = await io.confirm.readSecret("Type it again to confirm: ")
  if (!second) {
    io.print("Cancelled; no key was sealed.")
    return 1
  }
  if (first !== second) {
    io.print("The two passphrases do not match; nothing was sealed.")
    return 1
  }
  try {
    const { keyId } = await sealHumanKey(first, io.stateDir)
    io.print(`Sealed the human key ${keyId}; approvals, waivers and trust must now be recorded again.`)
    return 0
  } catch (error) {
    if (error instanceof HumanKeyError) {
      io.print(error.message)
      return 1
    }
    throw error
  }
}

export async function keyStatus(io: MainIO): Promise<number> {
  const id = await humanKeyId(io.stateDir)
  io.print(
    id
      ? `Human key ${id} is sealed on this machine.`
      : "No passphrase-sealed human key on this machine: run `es key seal` once at a terminal.",
  )
  return 0
}
