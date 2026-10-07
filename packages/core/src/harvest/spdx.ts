// Deterministic SPDX license detection. Detection is signature-based over
// local bytes: each license has phrases that must all appear (and phrases that
// must not). A LICENSE file match is the strongest evidence; explicit
// `SPDX-License-Identifier` headers are next; manifest fields are self-reported
// claims (verified: false) and alone can never authorize depend/vendor.
// Unknown or non-whitelisted licenses fail closed to clean-room.
import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import path from "node:path"
import type { LicenseFinding } from "../schema/harvest.ts"
import { readRegularFile } from "../util/fs.ts"

interface Signature {
  readonly spdx: string
  readonly family: LicenseFinding["family"]
  /** Every phrase must appear in the normalised text. */
  readonly all: readonly string[]
  /** At least one of these must appear. */
  readonly any?: readonly string[]
  /** None of these may appear (used to split near-identical texts). */
  readonly none?: readonly string[]
}

// Order matters only for ties; more specific signatures come first.
const SIGNATURES: readonly Signature[] = [
  { spdx: "AGPL-3.0", family: "copyleft", all: ["gnu affero general public license", "version 3"] },
  { spdx: "LGPL-3.0", family: "weak-copyleft", all: ["gnu lesser general public license", "version 3"] },
  { spdx: "GPL-3.0", family: "copyleft", all: ["gnu general public license", "version 3"] },
  { spdx: "GPL-2.0", family: "copyleft", all: ["gnu general public license", "version 2"] },
  { spdx: "MPL-2.0", family: "weak-copyleft", all: ["mozilla public license"], any: ["version 2.0", "v. 2.0"] },
  { spdx: "Apache-2.0", family: "permissive", all: ["apache license", "version 2.0, january 2004"] },
  {
    spdx: "ISC",
    family: "permissive",
    all: [
      "permission to use, copy, modify, and/or distribute this software for any purpose with or without fee",
      "this permission notice appear in all copies",
    ],
  },
  {
    spdx: "0BSD",
    family: "permissive",
    all: ["permission to use, copy, modify, and/or distribute this software for any purpose with or without fee"],
    none: ["in all copies"],
  },
  {
    spdx: "MIT",
    family: "permissive",
    all: ["permission is hereby granted, free of charge"],
    any: ['provided "as is"'],
  },
  {
    spdx: "BSD-3-Clause",
    family: "permissive",
    all: ["redistribution and use in source and binary forms", "neither the name"],
  },
  {
    spdx: "BSD-2-Clause",
    family: "permissive",
    all: ["redistribution and use in source and binary forms"],
    none: ["neither the name"],
  },
  {
    spdx: "Unlicense",
    family: "public-domain",
    all: ["this is free and unencumbered software released into the public domain"],
  },
  { spdx: "CC0-1.0", family: "public-domain", all: ["cc0 1.0 universal"] },
]

const CANONICAL: Readonly<Record<string, string>> = {
  mit: "MIT",
  "apache-2.0": "Apache-2.0",
  "bsd-2-clause": "BSD-2-Clause",
  "bsd-3-clause": "BSD-3-Clause",
  isc: "ISC",
  "0bsd": "0BSD",
  unlicense: "Unlicense",
  "cc0-1.0": "CC0-1.0",
  "mpl-2.0": "MPL-2.0",
  "gpl-2.0": "GPL-2.0",
  "gpl-2.0-only": "GPL-2.0",
  "gpl-2.0-or-later": "GPL-2.0",
  "gpl-3.0": "GPL-3.0",
  "gpl-3.0-only": "GPL-3.0",
  "gpl-3.0-or-later": "GPL-3.0",
  "agpl-3.0": "AGPL-3.0",
  "agpl-3.0-only": "AGPL-3.0",
  "agpl-3.0-or-later": "AGPL-3.0",
  "lgpl-3.0": "LGPL-3.0",
  "lgpl-2.1": "LGPL-2.1",
}

/** The license family for an arbitrary SPDX id (unknown ids stay unknown). */
export function familyOf(spdx: string): LicenseFinding["family"] {
  const known = SIGNATURES.find((signature) => signature.spdx === spdx)
  if (known) return known.family
  const id = spdx.toLowerCase()
  if (id.startsWith("agpl") || id.startsWith("gpl")) return "copyleft"
  if (id.startsWith("lgpl") || id.startsWith("mpl") || id.startsWith("epl") || id.startsWith("cddl"))
    return "weak-copyleft"
  if (id === "cc0-1.0" || id === "unlicense") return "public-domain"
  if (/^(mit|apache-2\.0|bsd-|isc|0bsd)$/.test(id) || id.startsWith("bsd-")) return "permissive"
  return "unknown"
}

export function normalizeLicenseId(id: string): string {
  let trimmed = id.trim()
  while (trimmed.endsWith("`") || trimmed.endsWith(";")) trimmed = trimmed.slice(0, -1)
  return CANONICAL[trimmed.toLowerCase()] ?? trimmed
}

/** Lowercase, straighten typography and collapse whitespace. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** The strongest signature match in a text, or undefined. */
export function matchSignature(text: string): Signature | undefined {
  const normalized = normalizeText(text)
  let best: { signature: Signature; score: number } | undefined
  for (const signature of SIGNATURES) {
    if (!signature.all.every((phrase) => normalized.includes(phrase))) continue
    if (signature.any?.length && !signature.any.some((phrase) => normalized.includes(phrase))) continue
    if (signature.none?.some((phrase) => normalized.includes(phrase))) continue
    const score = signature.all.length + (signature.any?.length ? 1 : 0) + (signature.none?.length ? 1 : 0)
    if (!best || score > best.score) best = { signature, score }
  }
  return best?.signature
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")

export interface LicenseScanIO {
  readonly readdir?: (dir: string) => Promise<string[]>
  readonly readFile?: (file: string) => Promise<string>
}

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt|rst))?$/i

/** Detect the license of a project directory from its bytes, in priority order. */
export async function detectLicense(
  dir: string,
  options: { maxHeaderFiles?: number; io?: LicenseScanIO } = {},
): Promise<LicenseFinding> {
  // Harvested content is untrusted: list only regular files and real
  // directories, and read only regular files (a symlinked LICENSE could point
  // anywhere on the machine).
  const readdirImpl =
    options.io?.readdir ??
    (async (target: string) =>
      (await readdir(target, { withFileTypes: true }))
        .filter((entry) => entry.isFile() || entry.isDirectory())
        .map((entry) => entry.name))
  const readFileImpl =
    options.io?.readFile ??
    (async (file: string) => {
      const text = await readRegularFile(file)
      if (text === undefined) throw new Error(`not a regular file: ${file}`)
      return text
    })

  // 1. LICENSE / COPYING files (the strongest evidence).
  const entries = await readdirImpl(dir).catch(() => [] as string[])
  for (const name of entries.filter((entry) => LICENSE_FILE.test(entry)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const file = path.join(dir, name)
    const text = await readFileImpl(file).catch(() => undefined)
    if (text === undefined) continue
    const signature = matchSignature(text)
    if (signature)
      return {
        spdx: signature.spdx,
        family: signature.family,
        source: "license-file",
        file: name,
        sha256: sha256(text),
        confidence: "high",
        verified: true,
      }
  }

  // 2. SPDX headers in source files.
  const header = await findSpdxHeader(dir, options.maxHeaderFiles ?? 200, { readdirImpl, readFileImpl })
  if (header)
    return {
      spdx: header.spdx,
      family: familyOf(header.spdx),
      source: "spdx-header",
      file: header.file,
      sha256: sha256(header.text),
      confidence: "medium",
      verified: true,
      note: "declared in a file header",
    }

  // 3. Manifest fields: self-reported claims, never enough to depend on.
  const manifest = await manifestLicense(dir, readFileImpl)
  if (manifest)
    return {
      spdx: normalizeLicenseId(manifest.spdx),
      family: familyOf(normalizeLicenseId(manifest.spdx)),
      source: "manifest",
      file: manifest.file,
      confidence: "medium",
      verified: false,
      note: "self-reported in a manifest; no license text found",
    }

  return {
    spdx: "unknown",
    family: "unknown",
    source: "manifest",
    confidence: "low",
    verified: false,
    note: "no license file, header or manifest field found",
  }
}

async function findSpdxHeader(
  dir: string,
  maxFiles: number,
  io: {
    readdirImpl: (dir: string) => Promise<string[]>
    readFileImpl: (file: string) => Promise<string>
  },
): Promise<{ spdx: string; file: string; text: string } | undefined> {
  const walk = async (
    relative: string,
    seen: { count: number },
  ): Promise<{ spdx: string; file: string; text: string } | undefined> => {
    if (seen.count >= maxFiles) return undefined
    const entries = await io.readdirImpl(path.join(dir, relative)).catch(() => [] as string[])
    for (const entry of entries) {
      if (seen.count >= maxFiles) return undefined
      if (entry === ".git" || entry === "node_modules" || entry === "dist" || entry === "build") continue
      const child = relative ? `${relative}/${entry}` : entry
      if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|cs|c|cc|cpp|h|hpp|swift|kt)$/i.test(entry)) {
        seen.count += 1
        const text = await io.readFileImpl(path.join(dir, child)).catch(() => undefined)
        if (text === undefined) continue
        const match = /spdx-license-identifier:\s*([\w.+-]+)/i.exec(text)
        if (match) return { spdx: normalizeLicenseId(match[1]!), file: child, text }
      } else if (!entry.startsWith(".") && !/\./.test(entry)) {
        const nested = await walk(child, seen)
        if (nested) return nested
      }
    }
    return undefined
  }
  return walk("", { count: 0 })
}

type ReadImpl = (file: string) => Promise<string>

async function manifestLicense(dir: string, read: ReadImpl): Promise<{ spdx: string; file: string } | undefined> {
  const packageJson = await read(path.join(dir, "package.json")).catch(() => undefined)
  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson) as { license?: unknown }
      const value = typeof pkg.license === "string" ? pkg.license : (pkg.license as { type?: string })?.type
      if (typeof value === "string" && value.trim()) return { spdx: value.trim(), file: "package.json" }
    } catch {}
  }
  const pyproject = await read(path.join(dir, "pyproject.toml")).catch(() => undefined)
  if (pyproject) {
    const match = /^\s*license\s*=\s*["']([^"']+)["']/m.exec(pyproject)
    if (match) return { spdx: match[1]!, file: "pyproject.toml" }
  }
  const cargo = await read(path.join(dir, "Cargo.toml")).catch(() => undefined)
  if (cargo) {
    const match = /^\s*license\s*=\s*["']([^"']+)["']/m.exec(cargo)
    if (match) return { spdx: match[1]!, file: "Cargo.toml" }
  }
  return undefined
}
