// Refactoring instances (#171): seeds work but smell; the oracle pins behaviour and shape.
import type { BenchmarkCase } from "../benchmarks.ts"
import { C } from "./shared.ts"

export const REFACTORING: readonly BenchmarkCase[] = [
  // Seeds work but smell; the oracle pins behaviour AND the refactored shape,
  // so seeds fail on constraints while references pass both.
  C(
    "ref-01-sum-reduce",
    "refactoring",
    1,
    "Replace the accumulation loop with reduce.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function total(prices: number[]): number {\n  let sum = 0\n  for (let i = 0; i < prices.length; i++) sum += prices[i]!\n  return sum\n}\n",
    },
    {
      properties: [
        { fn: "total", args: [[1, 2, 3]], expected: 6 },
        { fn: "total", args: [[]], expected: 0 },
      ],
      mustContain: [".reduce("],
      mustNotContain: ["for ("],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function total(prices: number[]): number {\n  return prices.reduce((a, b) => a + b, 0)\n}\n",
    },
  ),
  C(
    "ref-02-filter-map",
    "refactoring",
    1,
    "Replace the filter loop with filter/map.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function bigNames(users: Array<{name: string; age: number}>): string[] {\n  const out: string[] = []\n  for (const u of users) {\n    if (u.age >= 18) out.push(u.name.toUpperCase())\n  }\n  return out\n}\n",
    },
    {
      properties: [
        {
          fn: "bigNames",
          args: [
            [
              { name: "ann", age: 20 },
              { name: "bo", age: 10 },
            ],
          ],
          expected: ["ANN"],
        },
        { fn: "bigNames", args: [[]], expected: [] },
      ],
      mustContain: [".filter(", ".map("],
      mustNotContain: ["for ("],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function bigNames(users: Array<{name: string; age: number}>): string[] {\n  return users.filter((u) => u.age >= 18).map((u) => u.name.toUpperCase())\n}\n",
    },
  ),
  C(
    "ref-03-extract-discount",
    "refactoring",
    2,
    "Extract the inline discount rule into an applyDiscount helper.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function price(cart: number[], vip: boolean): number {\n  const sub = cart.reduce((a, b) => a + b, 0)\n  if (vip) return sub * 0.8\n  return sub\n}\n",
    },
    {
      properties: [
        { fn: "price", args: [[10, 20], true], expected: 24 },
        { fn: "price", args: [[10], false], expected: 10 },
      ],
      mustContain: ["function applyDiscount"],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "function applyDiscount(sub: number, vip: boolean): number {\n  return vip ? sub * 0.8 : sub\n}\n\nexport function price(cart: number[], vip: boolean): number {\n  return applyDiscount(cart.reduce((a, b) => a + b, 0), vip)\n}\n",
    },
  ),
  C(
    "ref-04-early-return",
    "refactoring",
    1,
    "Flatten nested conditionals into guard clauses.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function label(age: number): string {\n  let out = 'minor'\n  if (age >= 18) {\n    out = 'adult'\n    if (age >= 65) out = 'senior'\n  }\n  return out\n}\n",
    },
    {
      properties: [
        { fn: "label", args: [10], expected: "minor" },
        { fn: "label", args: [30], expected: "adult" },
        { fn: "label", args: [70], expected: "senior" },
      ],
      mustContain: ["return 'senior'"],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function label(age: number): string {\n  if (age >= 65) return 'senior'\n  if (age >= 18) return 'adult'\n  return 'minor'\n}\n",
    },
  ),
  C(
    "ref-05-const-bindings",
    "refactoring",
    1,
    "Use const for bindings that are never reassigned.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function circle(r: number): {area: number; circ: number} {\n  let area = Math.PI * r * r\n  let circ = 2 * Math.PI * r\n  return { area, circ }\n}\n",
    },
    {
      properties: [{ fn: "circle", args: [1], expected: { area: Math.PI, circ: 2 * Math.PI } }],
      mustNotContain: ["let "],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function circle(r: number): {area: number; circ: number} {\n  const area = Math.PI * r * r\n  const circ = 2 * Math.PI * r\n  return { area, circ }\n}\n",
    },
  ),
  C(
    "ref-06-template-literal",
    "refactoring",
    1,
    "Replace string concatenation with a template literal.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function greet(name: string, n: number): string {\n  return 'Hello, ' + name + '! You have ' + n + ' messages.'\n}\n",
    },
    {
      properties: [{ fn: "greet", args: ["Ann", 3], expected: "Hello, Ann! You have 3 messages." }],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional embedded template syntax under test.
      mustContain: ["${name}"],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional embedded template syntax under test.
        "export function greet(name: string, n: number): string {\n  return `Hello, ${name}! You have ${n} messages.`\n}\n",
    },
  ),
  C(
    "ref-07-destructure",
    "refactoring",
    1,
    "Destructure the user object instead of repeating property access.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function fullname(user: {first: string; last: string}): string {\n  return user.first + ' ' + user.last\n}\n",
    },
    {
      properties: [{ fn: "fullname", args: [{ first: "Ada", last: "Lovelace" }], expected: "Ada Lovelace" }],
      mustContain: ["const { first, last }"],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function fullname(user: {first: string; last: string}): string {\n  const { first, last } = user\n  return first + ' ' + last\n}\n",
    },
  ),
  C(
    "ref-08-pure-take-last",
    "refactoring",
    2,
    "Stop mutating the input: return the tail without pop.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function takeLast(items: number[]): {item: number | undefined; rest: number[]} {\n  const item = items.pop()\n  return { item, rest: items }\n}\n",
    },
    {
      properties: [
        { fn: "takeLast", args: [[1, 2, 3]], expected: { item: 3, rest: [1, 2] } },
        { fn: "takeLast", args: [[]], expected: { item: undefined, rest: [] } },
      ],
      mustContain: [".slice("],
      mustNotContain: [".pop("],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function takeLast(items: number[]): {item: number | undefined; rest: number[]} {\n  return { item: items[items.length - 1], rest: items.slice(0, -1) }\n}\n",
    },
  ),
  C(
    "ref-09-async-await",
    "refactoring",
    2,
    "Replace the promise chain with async/await.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "function load(): Promise<number> {\n  return Promise.resolve(21)\n}\n\nexport function doubled(): Promise<number> {\n  return load().then((x) => x * 2)\n}\n",
    },
    {
      properties: [{ fn: "doubled", args: [], expected: 42 }],
      mustContain: ["await"],
      mustNotContain: [".then("],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "function load(): Promise<number> {\n  return Promise.resolve(21)\n}\n\nexport async function doubled(): Promise<number> {\n  const x = await load()\n  return x * 2\n}\n",
    },
  ),
  C(
    "ref-10-named-constant",
    "refactoring",
    1,
    "Name the magic tax rate.",
    "src/solution.ts",
    {
      "src/solution.ts": "export function withTax(sub: number): number {\n  return sub + sub * 0.07\n}\n",
    },
    {
      properties: [{ fn: "withTax", args: [100], expected: 107 }],
      mustContain: ["TAX_RATE"],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "const TAX_RATE = 0.07\n\nexport function withTax(sub: number): number {\n  return sub + sub * TAX_RATE\n}\n",
    },
  ),
  C(
    "ref-11-remove-dead-code",
    "refactoring",
    1,
    "Delete the unused legacy helper.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function double(n: number): number {\n  return n * 2\n}\n\nfunction legacyCompute(n: number): number {\n  return n + n\n}\n",
    },
    {
      properties: [{ fn: "double", args: [21], expected: 42 }],
      mustNotContain: ["legacyCompute"],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts": "export function double(n: number): number {\n  return n * 2\n}\n",
    },
  ),
  C(
    "ref-12-flatten-conditionals",
    "refactoring",
    1,
    "Collapse the nested if/else into one boolean expression.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function canEdit(role: string, isOwner: boolean): boolean {\n  if (role === 'admin') {\n    return true\n  } else {\n    if (isOwner) {\n      return true\n    } else {\n      return false\n    }\n  }\n}\n",
    },
    {
      properties: [
        { fn: "canEdit", args: ["admin", false], expected: true },
        { fn: "canEdit", args: ["user", true], expected: true },
        { fn: "canEdit", args: ["user", false], expected: false },
      ],
      mustContain: ["||"],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function canEdit(role: string, isOwner: boolean): boolean {\n  return role === 'admin' || isOwner\n}\n",
    },
  ),
]
