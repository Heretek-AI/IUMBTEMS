import type { GateFinding } from "../schema/gates.ts"

const SECRET_PATTERNS: ReadonlyArray<{ rule: string; regex: RegExp; description: string }> = [
  {
    rule: "security/secret-aws-key",
    regex: /\b(AKIA[0-9A-Z]{16})\b/g,
    description: "AWS Access Key ID",
  },
  {
    rule: "security/secret-github-token",
    regex: /\b(gh[pousr]_[A-Za-z0-9_]{36,255})\b/g,
    description: "GitHub Personal Access Token",
  },
  {
    rule: "security/secret-private-key",
    regex: /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----/g,
    description: "Unencrypted Private Key Block",
  },
  {
    rule: "security/secret-slack-token",
    regex: /\b(xox[baprs]-[0-9a-zA-Z-]{10,72})\b/g,
    description: "Slack API Token",
  },
  {
    rule: "security/secret-stripe-key",
    regex: /\b(sk_live_[0-9a-zA-Z]{24,})\b/g,
    description: "Stripe Live Secret Key",
  },
]

export function scanForSecrets(content: string, filePath: string): GateFinding[] {
  const findings: GateFinding[] = []
  const lines = content.split("\n")

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!
    for (const pattern of SECRET_PATTERNS) {
      pattern.regex.lastIndex = 0
      const match = pattern.regex.exec(line)
      if (match) {
        findings.push({
          file: filePath,
          line: lineIndex + 1,
          column: match.index + 1,
          rule: pattern.rule,
          severity: "error",
          message: `Detected potential secret: ${pattern.description}`,
          fixHint: "Remove secret and load from environment variables or a secret store.",
        })
      }
    }
  }

  return findings
}
