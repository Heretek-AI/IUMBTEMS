// One CLI argument grammar, shared by the CLI and the human-only policy
// (#97): positionals, --flag, --flag=value, --flag value. The policy
// (trust/policy.ts) reads the same grammar so a new flag cannot drift the
// two parsers apart again (#88).
export interface Args {
  readonly positionals: string[]
  readonly flags: Record<string, string | boolean>
}

export function parseArgs(argv: readonly string[], booleans: readonly string[] = []): Args {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s)
      if (inline !== undefined) flags[name!] = inline
      else if (booleans.includes(name!) || argv[i + 1] === undefined || argv[i + 1]!.startsWith("--"))
        flags[name!] = true
      else flags[name!] = argv[++i]!
    } else positionals.push(arg)
  }
  return { positionals, flags }
}

export const flag = (args: Args, name: string): string | undefined => {
  const value = args.flags[name]
  return typeof value === "string" ? value : undefined
}

/** Every flag the CLI reads as a bare boolean (never consuming the next word). */
export const BOOLEAN_FLAGS: readonly string[] = [
  "full",
  "staged",
  "json",
  "show",
  "headless",
  "accept-drift",
  "extend-runtime",
  "uninstall",
  "help",
  "force",
  "allow-unverifiable",
  "global",
  "open-only",
  "sign",
  "all",
]
