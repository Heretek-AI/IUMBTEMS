// Human confirmation for the CLI half of the human-only channel. Refuses
// without an interactive terminal on both stdin and stdout. Since 1.1.1 every
// human action is confirmed with the human's passphrase, read with echo off,
// which unlocks the human key (core approval/keystore.ts): an agent that
// drives this prompt through a PTY can read everything on screen, but not the
// passphrase. Signing actions use the unlocked key; the rest use the unlock
// as proof that the human is at the keyboard.
import { createInterface } from "node:readline"
import { type HumanSigner, HumanKeyError, unlockHumanKey } from "@heretek-ai/es-core"

export interface ConfirmIO {
  readonly interactive: boolean
  write(text: string): void
  readLine(prompt: string): Promise<string>
  /** Read a line without echoing it (passphrases). */
  readSecret(prompt: string): Promise<string>
}

export const terminalIO = (): ConfirmIO => ({
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  write: (text) => process.stdout.write(text),
  readLine: (prompt) =>
    new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      rl.question(prompt, (answer) => {
        rl.close()
        resolve(answer)
      })
    }),
  readSecret: (prompt) =>
    new Promise((resolve) => {
      const stdin = process.stdin
      const wasRaw = stdin.isRaw
      process.stdout.write(prompt)
      stdin.setRawMode?.(true)
      stdin.setEncoding("utf8")
      stdin.resume()
      let value = ""
      const done = () => {
        stdin.off("data", onData)
        stdin.setRawMode?.(wasRaw ?? false)
        stdin.pause()
        process.stdout.write("\n")
        resolve(value)
      }
      const onData = (chunk: string) => {
        for (const char of chunk) {
          if (char === "\r" || char === "\n" || char === "\u0004") return done()
          if (char === "\u0003") {
            value = ""
            return done()
          }
          value = char === "\u007f" || char === "\b" ? value.slice(0, -1) : value + char
        }
      }
      stdin.on("data", onData)
    }),
})

export class NotInteractive extends Error {
  constructor(action: string) {
    super(`${action} needs a human at an interactive terminal (stdin and stdout must be a TTY).`)
  }
}

/**
 * Show what the action does, then ask for the passphrase. Returns the unlocked
 * human key, or undefined when the human cancels or the passphrase is wrong
 * (the reason is written to the terminal).
 */
export async function confirmHuman(
  io: ConfirmIO,
  action: string,
  lines: readonly string[],
  stateDir?: string,
): Promise<HumanSigner | undefined> {
  if (!io.interactive) throw new NotInteractive(action)
  io.write(`\n${action}\n${"─".repeat(Math.min(72, action.length + 8))}\n${lines.join("\n")}\n\n`)
  const passphrase = await io.readSecret("Your Epistemic Swarm passphrase (empty cancels): ")
  if (!passphrase) return undefined
  try {
    return await unlockHumanKey(passphrase, stateDir)
  } catch (error) {
    if (!(error instanceof HumanKeyError)) throw error
    io.write(`${error.message}\n`)
    return undefined
  }
}
