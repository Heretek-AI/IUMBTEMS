// Generate the machine contracts and docs from the Zod schemas, and fail on
// drift. This is the single pipeline CI runs:
//
//   bun scripts/docs.ts          write schemas/*.schema.json + docs/SCHEMAS.md
//   bun scripts/docs.ts --check  exit 1 when the committed outputs differ
//
// The capability matrix and config docs join this script in later M6 work;
// the drift mechanics live here once.
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import * as z from "zod"
import { CAPABILITY_MATRIX, enforcedWithoutProof } from "../packages/core/src/capabilities.ts"
import { HOOK_CAPABILITIES } from "../packages/core/src/hooks/compile.ts"
import * as schemas from "../packages/core/src/schema/index.ts"

const root = path.resolve(import.meta.dir, "..")
const check = process.argv.includes("--check")

const kebab = (name: string) =>
  name
    .replace(/Schema$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()

const schemaDir = path.join(root, "schemas")
const docsFile = path.join(root, "docs", "SCHEMAS.md")

interface Output {
  readonly file: string
  readonly content: string
}

const outputs: Output[] = []
for (const [name, value] of Object.entries(schemas)) {
  if (!(value instanceof z.ZodType)) continue
  outputs.push({
    file: `schemas/${kebab(name)}.schema.json`,
    content: `${JSON.stringify(z.toJSONSchema(value), null, 2)}\n`,
  })
}
outputs.sort((a, b) => a.file.localeCompare(b.file))

const docs = [
  "# Generated contracts",
  "",
  "JSON Schema renderings of the Zod contracts in `packages/core/src/schema/`.",
  "Do not edit by hand: run `bun run docs:gen` after changing a schema (CI runs `bun run docs:check` on drift).",
  "",
  "| schema | file |",
  "| --- | --- |",
  ...outputs.map((output) => `| ${path.basename(output.file).replace(/\.schema\.json$/, "")} | \`${output.file}\` |`),
  "",
].join("\n")

// ------------------------------------------------- capability matrix doc
// ENFORCED rows must name a proof that exists in the repo: a missing file is
// a contract error, not a warning.
const missingProofs = Object.values(CAPABILITY_MATRIX)
  .flatMap((rows) => rows.filter((row) => row.support === "enforced" && row.test))
  .map((row) => row.test!)
  .filter((test) => !existsSync(path.join(root, test)))
for (const harness of Object.keys(CAPABILITY_MATRIX) as Array<keyof typeof CAPABILITY_MATRIX>)
  for (const row of enforcedWithoutProof(harness)) missingProofs.push(`${harness}: ${row.capability} (no proof)`)
if (missingProofs.length) {
  console.error(`docs: ENFORCED capability rows without a proof:\n${[...new Set(missingProofs)].map((item) => `  ${item}`).join("\n")}`)
  process.exit(1)
}

const capabilitiesDoc = [
  "# Capability matrix",
  "",
  "What each harness actually enforces, declared once in `packages/core/src/capabilities.ts`.",
  "ENFORCED rows name the test or spike that proves them; ADVISORY rows are best-effort and",
  "labelled as such in the hook inspector; UNSUPPORTED rows are declared gaps (the Claude, Pi",
  "and Antigravity adapters ship in 1.1–1.3). Generated: do not edit by hand.",
  "",
  ...Object.entries(CAPABILITY_MATRIX).flatMap(([harness, rows]) => [
    `## ${harness}`,
    "",
    "| capability | support | proof | detail |",
    "| --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row.capability} | ${row.support.toUpperCase()} | ${row.test ? `\`${row.test}\`` : "—"} | ${row.detail.replace(/\\/g, "\\\\").replace(/\|/g, "\\|")} |`,
    ),
    "",
  ]),
  "## Hook bridge detail",
  "",
  "| harness | event | support |",
  "| --- | --- | --- |",
  ...Object.entries(HOOK_CAPABILITIES).flatMap(([harness, caps]) =>
    Object.entries(caps.events).map(([event, support]) => `| ${harness} | ${event} | ${support.toUpperCase()} |`),
  ),
  "",
].join("\n")

// ------------------------------------------------- config doc
const configSchema = outputs.find((output) => output.file === "schemas/es-config.schema.json")
if (!configSchema) throw new Error("docs: schemas/es-config.schema.json missing; is EsConfigSchema exported?")
const configJson = JSON.parse(configSchema.content) as {
  properties?: Record<string, { type?: string; default?: unknown; description?: string; enum?: unknown[]; anyOf?: unknown[] }>
}
const configDoc = [
  "# Config",
  "",
  "The canonical Epistemic Swarm config (`packages/core/src/schema/config.ts`), layered:",
  "user-global (`~/.config/epistemic-swarm/config.json`) → project (`.factory/config.json`) →",
  "plugin options in `opencode.json`. Unknown keys are rejected. Generated: do not edit by hand.",
  "",
  "| field | type | default | description |",
  "| --- | --- | --- | --- |",
  ...Object.entries(configJson.properties ?? {}).map(([name, property]) => {
    const type = property.type ?? (property.enum ? "enum" : property.anyOf ? "union" : "object")
    const fallback = property.default === undefined ? "—" : `\`${JSON.stringify(property.default)}\``
    return `| \`${name}\` | ${type}${property.enum ? ` (${property.enum.join(", ")})` : ""} | ${fallback} | ${(property.description ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|")} |`
  }),
  "",
  "`es config show` and `/config` print the effective config and which files contributed.",
  "",
].join("\n")

const desired = new Map<string, string>([
  ...outputs.map((output) => [output.file, output.content] as const),
  ["docs/SCHEMAS.md", docs],
  ["docs/CAPABILITIES.md", capabilitiesDoc],
  ["docs/CONFIG.md", configDoc],
])

// Stale files: committed schemas with no counterpart in code.
const existing = (await readdir(schemaDir).catch(() => [] as string[]))
  .filter((file) => file.endsWith(".schema.json"))
  .map((file) => `schemas/${file}`)
const stale = existing.filter((file) => !desired.has(file))

if (check) {
  const drift: string[] = []
  for (const [file, content] of desired) {
    const onDisk = await readFile(path.join(root, file), "utf8").catch(() => undefined)
    if (onDisk !== content) drift.push(file)
  }
  for (const file of stale) drift.push(`${file} (stale)`)
  if (drift.length) {
    console.error(`docs: ${drift.length} generated file(s) out of date:\n${drift.map((file) => `  ${file}`).join("\n")}`)
    console.error("Run `bun run docs:gen` and commit the result.")
    process.exit(1)
  }
  console.log(`docs: ${desired.size} generated file(s) up to date`)
} else {
  await mkdir(schemaDir, { recursive: true })
  await mkdir(path.dirname(docsFile), { recursive: true })
  for (const [file, content] of desired) await writeFile(path.join(root, file), content)
  for (const file of stale) await rm(path.join(root, file), { force: true })
  console.log(`docs: wrote ${desired.size} file(s) (${outputs.length} schemas${stale.length ? `, removed ${stale.length} stale` : ""})`)
}
