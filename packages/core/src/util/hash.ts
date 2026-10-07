import { createHash } from "node:crypto"

/** Hex sha256 of a string or bytes. */
export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

/** Stable JSON: object keys sorted recursively, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

/** Recursive key sort for stable JSON (indented renders, manifest bytes). */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as object).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      const item = (value as Record<string, unknown>)[key]
      if (item !== undefined) out[key] = sortKeys(item)
    }
    return out
  }
  return value
}

export const hashJson = (value: unknown) => sha256(canonicalJson(value))

/** Short display form of a hash. */
export const shortHash = (hash: string) => hash.slice(0, 12)
