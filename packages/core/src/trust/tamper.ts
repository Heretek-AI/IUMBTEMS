import { readFile } from "node:fs/promises"
import path from "node:path"
import { matchGlob } from "../util/glob.ts"
import { sha256 } from "../util/hash.ts"

export const CONTROL_FILE_PATTERNS = [
  ".factory/gates.json",
  ".factory/waivers/**",
  ".factory/approvals/**",
  ".factory/audit.jsonl",
  ".factory/frontier.json",
  ".factory/state.json",
  ".opencode/hooks.json",
  ".claude/settings.json",
] as const

export function isControlPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "")
  return CONTROL_FILE_PATTERNS.some((pattern) => matchGlob(normalized, pattern))
}

export async function hashFile(absolutePath: string): Promise<string> {
  const buffer = await readFile(absolutePath)
  return sha256(buffer)
}

export function pinCommandHash(command: string): string {
  return sha256(command.trim())
}

export function verifyCommandHash(command: string, expectedHash: string): boolean {
  return pinCommandHash(command) === expectedHash
}

export interface TamperCheckResult {
  readonly clean: boolean
  readonly violations: readonly string[]
}

export async function verifyControlFiles(
  rootDir: string,
  baselineHashes: Readonly<Record<string, string>>,
): Promise<TamperCheckResult> {
  const violations: string[] = []

  for (const [relPath, expectedHash] of Object.entries(baselineHashes)) {
    const fullPath = path.join(rootDir, relPath)
    try {
      const currentHash = await hashFile(fullPath)
      if (currentHash !== expectedHash) {
        violations.push(`Control file "${relPath}" tampered! Expected hash ${expectedHash}, found ${currentHash}`)
      }
    } catch (err: any) {
      if (err.code === "ENOENT") {
        violations.push(`Control file "${relPath}" missing (expected hash ${expectedHash})`)
      } else {
        violations.push(`Failed reading control file "${relPath}": ${err.message}`)
      }
    }
  }

  return {
    clean: violations.length === 0,
    violations,
  }
}
