// DTCG-shaped token schema: validation, alias resolution and reuse
// accounting. The dialect is deliberately not invented here: tokens are plain
// nested JSON with `$value` / `$type` / `$description` plus `{dotted.alias}`
// references (the Style-Dictionary-compat input shape carrying the W3C DTCG
// generic-token methodology). Any other `$`-prefixed key is refused, never
// silently skipped.
export const DTCG_SNAPSHOT = "2025.10"

/** `{group.sub.name}` alias references. */
const ALIAS_PATTERN = /\{([A-Za-z0-9_][A-Za-z0-9_.-]*)\}/g
const ALIAS_FULL = /^\{([A-Za-z0-9_][A-Za-z0-9_.-]*)\}$/

/** Domains where raw primitive values may be minted: `<domain>.primitive.<name>`. */
export const PRIMITIVE_DOMAINS = new Set(["color", "type", "space", "radius", "motion", "modes"])

/** The only `$`-prefixed keys the dialect defines. */
export const ALLOWED_DOLLAR_KEYS = new Set(["$value", "$type", "$description"])

export class CircularAliasError extends Error {}
export class UnknownAliasError extends Error {}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
export type TokenTree = Record<string, unknown>

export const isToken = (node: unknown): node is Record<string, Json | undefined> =>
  typeof node === "object" && node !== null && !Array.isArray(node) && "$value" in node

export const isAliasValue = (value: unknown): value is string =>
  typeof value === "string" && ALIAS_FULL.test(value.trim())

/** An alias embedded with raw text (`"#ff0000 {alias}"`): always an error. */
export const isMixedAliasValue = (value: unknown): boolean =>
  typeof value === "string" && new RegExp(ALIAS_PATTERN.source).test(value) && !isAliasValue(value)

export const aliasRefs = (value: unknown): string[] =>
  typeof value === "string" ? [...value.matchAll(ALIAS_PATTERN)].map((match) => match[1]!) : []

export interface TokenEntry {
  readonly path: readonly string[]
  readonly node: Record<string, unknown>
  readonly resolvedType: string | undefined
}

/** Yield every token in the tree, including list-smuggled ones. */
export function* iterTokens(
  tree: unknown,
  prefix: readonly string[] = [],
  inheritedType?: string,
): Generator<TokenEntry> {
  if (Array.isArray(tree)) {
    for (const [index, item] of tree.entries()) {
      const path = [...prefix, `[${index}]`]
      if (isToken(item))
        yield { path, node: item as Record<string, unknown>, resolvedType: resolveType(item, inheritedType) }
      else if (typeof item === "object" && item !== null) yield* iterTokens(item, path, inheritedType)
    }
    return
  }
  if (typeof tree !== "object" || tree === null) return
  const record = tree as Record<string, unknown>
  const groupType = typeof record.$type === "string" ? record.$type : inheritedType
  for (const [key, child] of Object.entries(record)) {
    if (key.startsWith("$")) continue
    if (isToken(child))
      yield {
        path: [...prefix, key],
        node: child as Record<string, unknown>,
        resolvedType: resolveType(child, groupType),
      }
    else if (typeof child === "object" && child !== null) yield* iterTokens(child, [...prefix, key], groupType)
  }
}

/** Type-resolution order: token `$type` wins, else the nearest group `$type`. */
function resolveType(node: unknown, inherited?: string): string | undefined {
  if (typeof node === "object" && node !== null) {
    const own = (node as Record<string, unknown>).$type
    if (typeof own === "string" && own.trim()) return own
  }
  return inherited
}

function walkPath(root: unknown, ref: string): unknown {
  let node: unknown = root
  for (const segment of ref.split(".")) {
    if (
      typeof node !== "object" ||
      node === null ||
      Array.isArray(node) ||
      !(segment in (node as Record<string, unknown>))
    )
      throw new UnknownAliasError(`alias {${ref}} does not resolve: missing "${segment}"`)
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

/** Follow one alias reference through chains to its raw value. */
export function resolveAlias(root: unknown, ref: string, seen: readonly string[] = []): unknown {
  if (seen.includes(ref))
    throw new CircularAliasError(`circular alias chain: ${[...seen, ref].map((item) => `{${item}}`).join(" -> ")}`)
  const target = walkPath(root, ref)
  const value = isToken(target) ? (target as Record<string, unknown>).$value : target
  if (isAliasValue(value)) {
    const refs = aliasRefs(value)
    if (refs.length === 1 && value.trim() === `{${refs[0]}}`) return resolveAlias(root, refs[0]!, [...seen, ref])
    let resolved = value
    for (const sub of refs) resolved = resolved.replaceAll(`{${sub}}`, String(resolveAlias(root, sub, [...seen, ref])))
    return resolved
  }
  return isToken(target) ? (target as Record<string, unknown>).$value : target
}

function unknownDollarErrors(node: unknown, prefix: readonly string[]): string[] {
  const errors: string[] = []
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries())
      if (typeof item === "object" && item !== null)
        errors.push(...unknownDollarErrors(item, [...prefix, `[${index}]`]))
    return errors
  }
  if (typeof node !== "object" || node === null) return errors
  const record = node as Record<string, unknown>
  for (const key of Object.keys(record))
    if (key.startsWith("$") && !ALLOWED_DOLLAR_KEYS.has(key))
      errors.push(
        `${prefix.length ? prefix.join(".") : "<root>"}: unknown $ key ${JSON.stringify(key)} refused (only $value/$type/$description allowed; $meta dialect not required)`,
      )
  for (const [key, child] of Object.entries(record)) {
    if (key.startsWith("$") && key !== "$value") continue
    const childPrefix = [...prefix, key]
    if (Array.isArray(child)) {
      for (const [index, item] of child.entries())
        if (typeof item === "object" && item !== null)
          errors.push(...unknownDollarErrors(item, [...childPrefix, `[${index}]`]))
    } else if (typeof child === "object" && child !== null) errors.push(...unknownDollarErrors(child, childPrefix))
  }
  return errors
}

/** Validate a token tree; returns error strings (empty = valid). */
export function validateTokens(tree: unknown): string[] {
  if (typeof tree !== "object" || tree === null || Array.isArray(tree)) return ["tokens root must be an object"]
  const errors = unknownDollarErrors(tree, [])
  for (const { path, node, resolvedType } of iterTokens(tree)) {
    const dotted = path.join(".")
    if (typeof resolvedType !== "string" || !resolvedType.trim())
      errors.push(`${dotted}: missing $type (no token $type and no group $type)`)
    const description = node.$description
    if (description !== undefined && typeof description !== "string")
      errors.push(`${dotted}: $description must be a string`)
    const value = node.$value
    if (isMixedAliasValue(value))
      errors.push(
        `${dotted}: mixed raw + alias $value ${JSON.stringify(value)} must be a pure '{dotted.ref}' alias (optional surrounding whitespace only)`,
      )
    for (const ref of aliasRefs(value)) {
      try {
        resolveAlias(tree, ref)
      } catch (error) {
        if (error instanceof CircularAliasError || error instanceof UnknownAliasError)
          errors.push(`${dotted}: ${error.message}`)
        else throw error
      }
    }
  }
  return errors
}

/** Raw values may only live under an allowlisted `<domain>.primitive.<name>`. */
function isPrimitivePath(path: readonly string[]): boolean {
  if (path.length !== 3) return false
  const [domain, layer] = path
  return layer === "primitive" && PRIMITIVE_DOMAINS.has(domain!)
}

export interface OneOff {
  readonly path: string
  readonly reason: string
}

/** Tokens with raw `$value` outside primitive groups (a compile error). */
export function findOneOffs(tree: unknown): OneOff[] {
  const oneOffs: OneOff[] = []
  for (const { path, node } of iterTokens(tree)) {
    const value = node.$value
    const dotted = path.join(".")
    if (isMixedAliasValue(value))
      oneOffs.push({ path: dotted, reason: "mixed raw + alias $value must be a pure '{dotted.ref}' alias" })
    else if (!isAliasValue(value) && !isPrimitivePath(path))
      oneOffs.push({ path: dotted, reason: "raw $value outside a primitive group" })
  }
  return oneOffs
}

/** (aliased, total, ratio) over all tokens. */
export function aliasReuseRatio(tree: unknown): { aliased: number; total: number; ratio: number } {
  let total = 0
  let aliased = 0
  for (const { node } of iterTokens(tree)) {
    total += 1
    if (isAliasValue(node.$value)) aliased += 1
  }
  return { aliased, total, ratio: total ? aliased / total : 1 }
}

export const countTokens = (tree: unknown): number => [...iterTokens(tree)].length
