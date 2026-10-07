// Minimal argv parser: positionals, --flag, --flag=value, --flag value.
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

/** "7d", "12h", "90m" or an ISO date → Date. */
export function parseExpiry(value: string, now = new Date()): Date {
  const match = /^(\d+)\s*([dhm])$/.exec(value.trim())
  if (match) {
    const n = Number(match[1])
    const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[match[2] as "d" | "h" | "m"]
    return new Date(now.getTime() + n * unit)
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`Cannot parse expiry "${value}" (use 7d, 12h or an ISO date)`)
  return date
}
