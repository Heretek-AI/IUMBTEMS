/** The `es` CLI version. Single source: kept equal to the package version by test/cli.test.ts. */
export const VERSION = "2.3.0"

/** Parse a semver "major.minor.patch" into numbers; undefined when malformed. */
export function parseVersion(value: string): { major: number; minor: number; patch: number } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim())
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/** Compare two semvers: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(
  a: { major: number; minor: number; patch: number },
  b: { major: number; minor: number; patch: number },
): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

export interface VersionSkew {
  /** The CLI is older than the writer and should warn (with the upgrade command). */
  readonly warn: boolean
  /** The major version differs: human-only commands are refused. */
  readonly refuseHuman: boolean
  readonly message?: string
}

/**
 * #356: the plugin updates through the opencode cache and the CLI through
 * global npm, so they drift silently. Run state records the version that
 * wrote it (`writerVersion`); an older `es` warns, and a different major
 * refuses human-only commands (state the old CLI cannot reason about).
 */
export function checkVersionSkew(cliVersion: string, writerVersion: string | undefined): VersionSkew {
  if (!writerVersion) return { warn: false, refuseHuman: false }
  const cli = parseVersion(cliVersion)
  const writer = parseVersion(writerVersion)
  if (!cli || !writer) return { warn: false, refuseHuman: false }
  if (compareVersions(cli, writer) >= 0) return { warn: false, refuseHuman: false }
  const message =
    `This es CLI (${cliVersion}) is older than the version that wrote this run's state (${writerVersion}). ` +
    `Update with \`npm i -g @heretek-ai/es-cli@${writerVersion}\` (or \`npm i -g @heretek-ai/es-cli@latest\`).`
  if (cli.major !== writer.major)
    return {
      warn: true,
      refuseHuman: true,
      message: `${message} Human-only commands are refused across a major version skew.`,
    }
  return { warn: true, refuseHuman: false, message }
}
