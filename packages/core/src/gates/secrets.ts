// Built-in secret scanner (always on, no external binary). High-precision
// patterns are errors; the generic assignment heuristic is a warning.
import { open } from "node:fs/promises"
import path from "node:path"
import type { GateFinding } from "../schema/gates.ts"

const PATTERNS: ReadonlyArray<{ rule: string; regex: RegExp; description: string; severity?: "warning" }> = [
  { rule: "security/secret-aws-key", regex: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/, description: "AWS access key ID" },
  {
    rule: "security/secret-github-token",
    regex: /\b(gh[pousr]_[A-Za-z0-9_]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/,
    description: "GitHub token",
  },
  {
    rule: "security/secret-private-key",
    regex: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
    description: "private key block",
  },
  { rule: "security/secret-slack-token", regex: /\b(xox[baprs]-[0-9A-Za-z-]{10,72})\b/, description: "Slack token" },
  {
    rule: "security/secret-stripe-key",
    regex: /\b((?:sk|rk)_live_[0-9A-Za-z]{24,})\b/,
    description: "Stripe live key",
  },
  { rule: "security/secret-anthropic-key", regex: /\b(sk-ant-[A-Za-z0-9_-]{32,})\b/, description: "Anthropic API key" },
  { rule: "security/secret-openai-key", regex: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{40,})\b/, description: "OpenAI API key" },
  { rule: "security/secret-google-key", regex: /\b(AIza[0-9A-Za-z_-]{35})\b/, description: "Google API key" },
  { rule: "security/secret-npm-token", regex: /\b(npm_[A-Za-z0-9]{36})\b/, description: "npm token" },
  {
    rule: "security/secret-assignment",
    regex: /\b(?:password|passwd|secret|api_?key|access_?token|auth_?token)\b\s*[:=]\s*["'][^"'\s$]{12,}["']/i,
    description: "hard-coded credential-like value",
    severity: "warning",
  },
]

const ALLOW_MARKER = /es-allow-secret|gitleaks:allow|pragma: allowlist secret/

export function scanForSecrets(content: string, file: string): GateFinding[] {
  if (content.includes("\u0000")) return []
  const findings: GateFinding[] = []
  content.split("\n").forEach((line, index) => {
    if (ALLOW_MARKER.test(line)) return
    for (const pattern of PATTERNS) {
      const match = pattern.regex.exec(line)
      if (!match) continue
      findings.push({
        file,
        line: index + 1,
        column: match.index + 1,
        rule: pattern.rule,
        severity: pattern.severity ?? "error",
        message: `Possible ${pattern.description}`,
        fixHint: "Load it from the environment or a secret store; rotate it if it was ever committed.",
        check: "secrets",
      })
    }
  })
  return findings
}

// Per-path cache keyed by mtime+size (mirrors structure/graph.ts), so repeated
// gate runs re-read only changed files. The scan itself is deliberately NOT
// count-capped the way gitleaks is: a cap would fail open, silently skipping a
// secret past the cap, while the cache bounds the repeated-run cost instead.
const fileCache = new Map<string, { mtimeMs: number; size: number; findings: GateFinding[] }>()
let cacheHits = 0

/**
 * Scan one file for secrets, cached by mtime+size. Missing, non-regular and
 * oversized (>2MB, as before) files yield no findings, as do binary files.
 */
export async function scanFileForSecrets(dir: string, file: string): Promise<GateFinding[]> {
  const absolute = path.join(dir, file)
  // Open once and stat the descriptor, so the size/mtime check and the read
  // cannot race with a concurrent replacement of the path.
  const handle = await open(absolute, "r").catch(() => undefined)
  if (!handle) return []
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 2_000_000) return []
    const cached = fileCache.get(absolute)
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      cacheHits += 1
      return cached.findings
    }
    const findings = scanForSecrets(await handle.readFile("utf8"), file)
    if (fileCache.size > 50_000) fileCache.clear()
    fileCache.set(absolute, { mtimeMs: info.mtimeMs, size: info.size, findings })
    return findings
  } finally {
    await handle.close()
  }
}

/** Cache observability: entries held and hits served since the last clear. */
export function secretScanStats(): { entries: number; hits: number } {
  return { entries: fileCache.size, hits: cacheHits }
}

/** For tests: forget cached findings and reset the hit count. */
export function clearSecretScanCache(): void {
  fileCache.clear()
  cacheHits = 0
}
