import { readFile } from "node:fs/promises"
import path from "node:path"

export interface StopFileCheck {
  readonly stopped: boolean
  readonly reason?: string
}

export async function checkStopFile(rootDir: string): Promise<StopFileCheck> {
  const stopFilePath = path.join(rootDir, ".factory", "STOP")
  try {
    const content = await readFile(stopFilePath, "utf8")
    const reason = content.trim() || "Manual kill-switch engaged via .factory/STOP file"
    return {
      stopped: true,
      reason,
    }
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return { stopped: false }
    }
    throw err
  }
}
