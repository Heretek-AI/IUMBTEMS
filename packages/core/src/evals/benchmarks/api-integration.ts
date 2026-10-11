// API-integration instances (#171): pagination, retries, parsing, routing, crypto.
import type { BenchmarkCase } from "../benchmarks.ts"
import { C } from "./shared.ts"

export const API_INTEGRATION: readonly BenchmarkCase[] = [
  C(
    "api-01-paginated-fetch",
    "api-integration",
    2,
    "Walk numbered pages until a page is missing, concatenating items.",
    "src/solution.ts",
    {
      "src/solution.ts":
        'export function fetchAll(client: {pages: Record<number, number[]>}, start: number): number[] {\n  throw new Error("stub")\n}\n',
    },
    {
      properties: [
        { fn: "fetchAll", args: [{ pages: { 1: [1, 2], 2: [3] } }, 1], expected: [1, 2, 3] },
        { fn: "fetchAll", args: [{ pages: { 1: [1, 2], 2: [3] } }, 2], expected: [3] },
        { fn: "fetchAll", args: [{ pages: {} }, 1], expected: [] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function fetchAll(client: {pages: Record<number, number[]>}, start: number): number[] {\n  const out: number[] = []\n  let page = start\n  while (client.pages[page] !== undefined) {\n    out.push(...client.pages[page]!)\n    page++\n  }\n  return out\n}\n",
    },
  ),
  C(
    "api-02-retry-backoff",
    "api-integration",
    2,
    "Retry a failing client up to maxAttempts, reporting value and attempts.",
    "src/solution.ts",
    {
      "src/solution.ts":
        'export function fetchWithRetry(client: {failuresLeft: number; value: number}, maxAttempts: number): {value: number; attempts: number} {\n  throw new Error("stub")\n}\n',
    },
    {
      properties: [
        { fn: "fetchWithRetry", args: [{ failuresLeft: 2, value: 7 }, 3], expected: { value: 7, attempts: 3 } },
        { fn: "fetchWithRetry", args: [{ failuresLeft: 5, value: 7 }, 3], expected: { value: -1, attempts: 3 } },
        { fn: "fetchWithRetry", args: [{ failuresLeft: 0, value: 9 }, 3], expected: { value: 9, attempts: 1 } },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function fetchWithRetry(client: {failuresLeft: number; value: number}, maxAttempts: number): {value: number; attempts: number} {\n  let attempts = 0\n  let left = client.failuresLeft\n  while (attempts < maxAttempts) {\n    attempts++\n    if (left > 0) left--\n    else return { value: client.value, attempts }\n  }\n  return { value: -1, attempts }\n}\n",
    },
  ),
  C(
    "api-03-debounce",
    "api-integration",
    3,
    "Trailing-edge debounce over timestamped events: fire an event only when nothing newer arrives within wait.",
    "src/solution.ts",
    {
      "src/solution.ts":
        'export function debounce(events: Array<[number, string]>, wait: number): Array<[number, string]> {\n  throw new Error("stub")\n}\n',
    },
    {
      properties: [
        {
          fn: "debounce",
          args: [
            [
              [0, "a"],
              [50, "b"],
              [200, "c"],
            ],
            100,
          ],
          expected: [
            [50, "b"],
            [200, "c"],
          ],
        },
        { fn: "debounce", args: [[[0, "a"]], 100], expected: [[0, "a"]] },
        { fn: "debounce", args: [[], 100], expected: [] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function debounce(events: Array<[number, string]>, wait: number): Array<[number, string]> {\n  const out: Array<[number, string]> = []\n  for (let i = 0; i < events.length; i++) {\n    const next = events[i + 1]\n    if (!next || next[0] - events[i]![0] > wait) out.push(events[i]!)\n  }\n  return out\n}\n",
    },
  ),
  C(
    "api-04-cache-aside",
    "api-integration",
    2,
    "Cache-aside read: serve from cache when present, else read the db once.",
    "src/solution.ts",
    {
      "src/solution.ts":
        'export function getUser(cache: Record<string, string>, db: Record<string, string>, id: string): {value: string; dbHits: number} {\n  throw new Error("stub")\n}\n',
    },
    {
      properties: [
        {
          fn: "getUser",
          args: [{ u1: "Ann" }, { u1: "Ann", u2: "Bo" }, "u1"],
          expected: { value: "Ann", dbHits: 0 },
        },
        {
          fn: "getUser",
          args: [{ u1: "Ann" }, { u1: "Ann", u2: "Bo" }, "u2"],
          expected: { value: "Bo", dbHits: 1 },
        },
        { fn: "getUser", args: [{}, {}, "ghost"], expected: { value: "missing", dbHits: 1 } },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function getUser(cache: Record<string, string>, db: Record<string, string>, id: string): {value: string; dbHits: number} {\n  if (cache[id] !== undefined) return { value: cache[id]!, dbHits: 0 }\n  return { value: db[id] ?? 'missing', dbHits: 1 }\n}\n",
    },
  ),
  C(
    "api-05-csv-parse",
    "api-integration",
    3,
    "Parse CSV with quoted fields, embedded commas and doubled quotes.",
    "src/solution.ts",
    { "src/solution.ts": 'export function parseCsv(text: string): string[][] {\n  throw new Error("stub")\n}\n' },
    {
      properties: [
        {
          fn: "parseCsv",
          args: ["a,b\nc,d"],
          expected: [
            ["a", "b"],
            ["c", "d"],
          ],
        },
        { fn: "parseCsv", args: ['a,"b,c",d'], expected: [["a", "b,c", "d"]] },
        { fn: "parseCsv", args: ['a,"b""c"'], expected: [["a", 'b"c']] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function parseCsv(text: string): string[][] {\n  const rows: string[][] = []\n  let row: string[] = []\n  let field = ''\n  let quoted = false\n  for (let i = 0; i < text.length; i++) {\n    const ch = text[i]!\n    if (quoted) {\n      if (ch === '\"') {\n        if (text[i + 1] === '\"') {\n          field += '\"'\n          i++\n        } else quoted = false\n      } else field += ch\n    } else if (ch === '\"') quoted = true\n    else if (ch === ',') {\n      row.push(field)\n      field = ''\n    } else if (ch === '\\n') {\n      row.push(field)\n      rows.push(row)\n      row = []\n      field = ''\n    } else field += ch\n  }\n  row.push(field)\n  rows.push(row)\n  return rows\n}\n",
    },
  ),
  C(
    "api-06-url-router",
    "api-integration",
    2,
    "Match a path against :param routes, extracting parameters.",
    "src/solution.ts",
    {
      "src/solution.ts":
        'export function matchRoute(routes: string[], path: string): {route: string; params: Record<string, string>} | null {\n  throw new Error("stub")\n}\n',
    },
    {
      properties: [
        {
          fn: "matchRoute",
          args: [["/users/:id", "/users/new"], "/users/42"],
          expected: { route: "/users/:id", params: { id: "42" } },
        },
        {
          fn: "matchRoute",
          args: [["/users/new", "/users/:id"], "/users/new"],
          expected: { route: "/users/new", params: {} },
        },
        { fn: "matchRoute", args: [["/a"], "/b"], expected: null },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function matchRoute(routes: string[], path: string): {route: string; params: Record<string, string>} | null {\n  const parts = path.split('/').filter((p) => p.length > 0)\n  for (const route of routes) {\n    const rparts = route.split('/').filter((p) => p.length > 0)\n    if (rparts.length !== parts.length) continue\n    const params: Record<string, string> = {}\n    let ok = true\n    for (let i = 0; i < rparts.length; i++) {\n      if (rparts[i]!.startsWith(':')) params[rparts[i]!.slice(1)] = parts[i]!\n      else if (rparts[i] !== parts[i]) {\n        ok = false\n        break\n      }\n    }\n    if (ok) return { route, params }\n  }\n  return null\n}\n",
    },
  ),
  C(
    "api-07-event-emitter",
    "api-integration",
    2,
    "Run an op script against a minimal emitter, returning received payloads.",
    "src/solution.ts",
    {
      "src/solution.ts":
        'export function runEmitter(ops: Array<[string, ...unknown[]]>): unknown[][] {\n  throw new Error("stub")\n}\n',
    },
    {
      properties: [
        {
          fn: "runEmitter",
          args: [
            [
              ["on", "a"],
              ["emit", "a", 1],
              ["emit", "b", 2],
              ["emit", "a", 3],
            ],
          ],
          expected: [
            ["a", 1],
            ["a", 3],
          ],
        },
        { fn: "runEmitter", args: [[["emit", "x", 1]]], expected: [] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function runEmitter(ops: Array<[string, ...unknown[]]>): unknown[][] {\n  const listeners = new Map<string, Array<(p: unknown) => void>>()\n  const received: unknown[][] = []\n  for (const [op, ...rest] of ops) {\n    if (op === 'on') {\n      const event = rest[0] as string\n      const fn = (p: unknown) => {\n        received.push([event, p])\n      }\n      listeners.set(event, [...(listeners.get(event) ?? []), fn])\n    } else {\n      for (const fn of listeners.get(rest[0] as string) ?? []) fn(rest[1])\n    }\n  }\n  return received\n}\n",
    },
  ),
  C(
    "api-08-deep-merge",
    "api-integration",
    2,
    "Deep-merge config objects: nested objects merge, arrays and scalars replace.",
    "src/solution.ts",
    {
      "src/solution.ts":
        'export function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {\n  throw new Error("stub")\n}\n',
    },
    {
      properties: [
        {
          fn: "deepMerge",
          args: [
            { a: 1, n: { x: 1, y: 2 } },
            { n: { y: 3 }, b: 2 },
          ],
          expected: { a: 1, n: { x: 1, y: 3 }, b: 2 },
        },
        { fn: "deepMerge", args: [{ l: [1] }, { l: [2, 3] }], expected: { l: [2, 3] } },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {\n  const out: Record<string, unknown> = { ...a }\n  for (const [k, v] of Object.entries(b)) {\n    const current = out[k]\n    if (v !== null && typeof v === 'object' && !Array.isArray(v) && current !== null && typeof current === 'object' && !Array.isArray(current))\n      out[k] = deepMerge(current as Record<string, unknown>, v as Record<string, unknown>)\n    else out[k] = v\n  }\n  return out\n}\n",
    },
  ),
  C(
    "api-09-webhook-hmac",
    "api-integration",
    3,
    "Verify a webhook HMAC-SHA256 signature in constant time.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function isValidSignature(payload: string, secret: string, signature: string): boolean {\n  return signature === payload\n}\n",
    },
    {
      properties: [
        {
          fn: "isValidSignature",
          args: ["hello", "s3cret", "e5a01537481fa0b2c697f787c7aff885412cf0760d08e08502259b39d2d6ae68"],
          expected: true,
        },
        { fn: "isValidSignature", args: ["hello", "s3cret", "deadbeef"], expected: false },
        {
          fn: "isValidSignature",
          args: ["hello", "wrong", "e5a01537481fa0b2c697f787c7aff885412cf0760d08e08502259b39d2d6ae68"],
          expected: false,
        },
      ],
      mustContain: ["timingSafeEqual"],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "import { createHmac, timingSafeEqual } from 'node:crypto'\n\nexport function isValidSignature(payload: string, secret: string, signature: string): boolean {\n  const expected = createHmac('sha256', secret).update(payload).digest('hex')\n  const a = Buffer.from(signature)\n  const b = Buffer.from(expected)\n  return a.length === b.length && timingSafeEqual(a, b)\n}\n",
    },
  ),
  C(
    "api-10-slugify",
    "api-integration",
    1,
    "Slugify a title: lowercase, non-alphanumerics to single dashes, trimmed.",
    "src/solution.ts",
    { "src/solution.ts": 'export function slugify(title: string): string {\n  throw new Error("stub")\n}\n' },
    {
      properties: [
        { fn: "slugify", args: ["Hello, World!"], expected: "hello-world" },
        { fn: "slugify", args: ["  A--B  "], expected: "a-b" },
        { fn: "slugify", args: [""], expected: "" },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function slugify(title: string): string {\n  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')\n}\n",
    },
  ),
  C(
    "api-11-config-flatten",
    "api-integration",
    2,
    "Flatten nested config into dotted keys under a prefix.",
    "src/solution.ts",
    {
      "src/solution.ts":
        'export function flatten(obj: Record<string, unknown>, prefix: string): Record<string, unknown> {\n  throw new Error("stub")\n}\n',
    },
    {
      properties: [
        { fn: "flatten", args: [{ a: { b: 1 }, c: 2 }, ""], expected: { "a.b": 1, c: 2 } },
        { fn: "flatten", args: [{ x: { y: { z: 3 } } }, "r"], expected: { "r.x.y.z": 3 } },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function flatten(obj: Record<string, unknown>, prefix: string): Record<string, unknown> {\n  const out: Record<string, unknown> = {}\n  for (const [k, v] of Object.entries(obj)) {\n    const key = prefix ? prefix + '.' + k : k\n    if (v !== null && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v as Record<string, unknown>, key))\n    else out[key] = v\n  }\n  return out\n}\n",
    },
  ),
  C(
    "api-12-chunk",
    "api-integration",
    1,
    "Chunk items into fixed-size batches; non-positive sizes yield [].",
    "src/solution.ts",
    {
      "src/solution.ts":
        'export function chunk(items: number[], size: number): number[][] {\n  throw new Error("stub")\n}\n',
    },
    {
      properties: [
        { fn: "chunk", args: [[1, 2, 3, 4, 5], 2], expected: [[1, 2], [3, 4], [5]] },
        { fn: "chunk", args: [[], 3], expected: [] },
        { fn: "chunk", args: [[1], 0], expected: [] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function chunk(items: number[], size: number): number[][] {\n  if (size <= 0) return []\n  const out: number[][] = []\n  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))\n  return out\n}\n",
    },
  ),
]
