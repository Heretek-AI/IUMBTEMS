import { readFile } from "node:fs/promises"
import { factoryLayout } from "../layout.ts"

export interface StopFileCheck {
  readonly stopped: boolean
  readonly reason?: string
}

/** The human kill-switch: any content in .factory/STOP halts tools and transitions. */
export async function checkStopFile(root: string): Promise<StopFileCheck> {
  try {
    const content = await readFile(factoryLayout(root).stop, "utf8")
    return { stopped: true, reason: content.trim() || "Kill-switch engaged via .factory/STOP" }
  } catch (error: any) {
    if (error?.code === "ENOENT") return { stopped: false }
    throw error
  }
}
