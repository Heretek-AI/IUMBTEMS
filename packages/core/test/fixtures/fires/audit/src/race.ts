import { existsSync, writeFileSync } from "node:fs"

export function claimLock(path: string) {
  if (existsSync(path)) return false
  writeFileSync(path, String(process.pid))
  return true
}
