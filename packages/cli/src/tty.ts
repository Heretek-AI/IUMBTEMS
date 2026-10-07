// Human confirmation for the CLI half of the human-only channel. Refuses
// without an interactive terminal on both stdin and stdout, and requires the
// human to type back a random code shown on screen (an agent piping "y"
// cannot satisfy it).
import { createInterface } from "node:readline"
import { confirmationCode } from "@heretek-ai/es-core"

export interface ConfirmIO {
  readonly interactive: boolean
  write(text: string): void
  readLine(prompt: string): Promise<string>
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
})

export class NotInteractive extends Error {
  constructor(action: string) {
    super(`${action} needs a human at an interactive terminal (stdin and stdout must be a TTY).`)
  }
}

/** Show `lines`, then ask the human to type a fresh code. Returns true only on an exact match. */
export async function confirmWithCode(io: ConfirmIO, action: string, lines: readonly string[]): Promise<boolean> {
  if (!io.interactive) throw new NotInteractive(action)
  const code = confirmationCode()
  io.write(
    `\n${action}\n${"─".repeat(Math.min(72, action.length + 8))}\n${lines.join("\n")}\n\nType ${code} to confirm (anything else cancels): `,
  )
  const answer = (await io.readLine("")).trim()
  return answer === code
}
