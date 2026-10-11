// Debugging instances (#171): seeds are real bugs; references hold every property.
import type { BenchmarkCase } from "../benchmarks.ts"
import { C } from "./shared.ts"

export const DEBUGGING: readonly BenchmarkCase[] = [
  // Seeds are real bugs: each fails at least one property while the reference
  // holds every property.
  C(
    "dbg-01-last-element",
    "debugging",
    1,
    "Return the last element; the seed reads one past the end.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function last(items: number[]): number | undefined {\n  return items[items.length]\n}\n",
    },
    {
      properties: [
        { fn: "last", args: [[1, 2, 3]], expected: 3 },
        { fn: "last", args: [[]], expected: undefined },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function last(items: number[]): number | undefined {\n  return items[items.length - 1]\n}\n",
    },
  ),
  C(
    "dbg-02-inclusive-range",
    "debugging",
    1,
    "Inclusive integer range; the seed drops the endpoint.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function range(lo: number, hi: number): number[] {\n  const out: number[] = []\n  for (let i = lo; i < hi; i++) out.push(i)\n  return out\n}\n",
    },
    {
      properties: [
        { fn: "range", args: [1, 5], expected: [1, 2, 3, 4, 5] },
        { fn: "range", args: [3, 3], expected: [3] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function range(lo: number, hi: number): number[] {\n  const out: number[] = []\n  for (let i = lo; i <= hi; i++) out.push(i)\n  return out\n}\n",
    },
  ),
  C(
    "dbg-03-null-guard",
    "debugging",
    1,
    "Read an optional name without crashing on null.",
    "src/solution.ts",
    {
      "src/solution.ts": "export function getName(user: {name: string} | null): string {\n  return user!.name\n}\n",
    },
    {
      properties: [
        { fn: "getName", args: [{ name: "Al" }], expected: "Al" },
        { fn: "getName", args: [null], expected: "anon" },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function getName(user: {name: string} | null): string {\n  return user?.name ?? 'anon'\n}\n",
    },
  ),
  C(
    "dbg-04-float-money",
    "debugging",
    2,
    "Add fractional amounts without binary floating-point dust.",
    "src/solution.ts",
    {
      "src/solution.ts": "export function addCents(a: number, b: number): number {\n  return a + b\n}\n",
    },
    {
      properties: [
        { fn: "addCents", args: [0.1, 0.2], expected: 0.3 },
        { fn: "addCents", args: [1.005, 0.005], expected: 1.01 },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function addCents(a: number, b: number): number {\n  return Math.round((a + b) * 100) / 100\n}\n",
    },
  ),
  C(
    "dbg-05-rotate-modulo",
    "debugging",
    2,
    "Rotate left with rotation counts larger than the array.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function rotateLeft(items: number[], n: number): number[] {\n  return [...items.slice(n), ...items.slice(0, n)]\n}\n",
    },
    {
      properties: [
        { fn: "rotateLeft", args: [[1, 2, 3], 1], expected: [2, 3, 1] },
        { fn: "rotateLeft", args: [[1, 2, 3], 4], expected: [2, 3, 1] },
        { fn: "rotateLeft", args: [[], 5], expected: [] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function rotateLeft(items: number[], n: number): number[] {\n  if (!items.length) return []\n  const k = ((n % items.length) + items.length) % items.length\n  return [...items.slice(k), ...items.slice(0, k)]\n}\n",
    },
  ),
  C(
    "dbg-06-leap-year",
    "debugging",
    2,
    "Full Gregorian leap-year rule; the seed forgets the century exception.",
    "src/solution.ts",
    {
      "src/solution.ts": "export function isLeap(year: number): boolean {\n  return year % 4 === 0\n}\n",
    },
    {
      properties: [
        { fn: "isLeap", args: [1900], expected: false },
        { fn: "isLeap", args: [2000], expected: true },
        { fn: "isLeap", args: [2024], expected: true },
        { fn: "isLeap", args: [2023], expected: false },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function isLeap(year: number): boolean {\n  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)\n}\n",
    },
  ),
  C(
    "dbg-07-weekend-sunday",
    "debugging",
    2,
    "Weekend check over UTC weekdays; the seed thinks Sunday is day 7.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function isWeekend(ymd: string): boolean {\n  const [y, m, d] = ymd.split('-').map(Number)\n  const day = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()\n  return day === 6 || day === 7\n}\n",
    },
    {
      properties: [
        { fn: "isWeekend", args: ["2026-10-11"], expected: true },
        { fn: "isWeekend", args: ["2026-10-10"], expected: true },
        { fn: "isWeekend", args: ["2026-10-12"], expected: false },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function isWeekend(ymd: string): boolean {\n  const [y, m, d] = ymd.split('-').map(Number)\n  const day = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()\n  return day === 0 || day === 6\n}\n",
    },
  ),
  C(
    "dbg-08-highlight-literal",
    "debugging",
    2,
    "Highlight a literal word; the seed feeds it to RegExp unescaped.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function highlight(text: string, word: string): string {\n  return text.replace(new RegExp(word, 'g'), '<b>' + word + '</b>')\n}\n",
    },
    {
      properties: [
        { fn: "highlight", args: ["say C++ now", "C++"], expected: "say <b>C++</b> now" },
        { fn: "highlight", args: ["aaa", "a"], expected: "<b>a</b><b>a</b><b>a</b>" },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function highlight(text: string, word: string): string {\n  return text.split(word).join('<b>' + word + '</b>')\n}\n",
    },
  ),
  C(
    "dbg-09-average-empty",
    "debugging",
    1,
    "Average of an empty list is 0, not NaN.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function average(nums: number[]): number {\n  return nums.reduce((a, b) => a + b, 0) / nums.length\n}\n",
    },
    {
      properties: [
        { fn: "average", args: [[1, 2, 3]], expected: 2 },
        { fn: "average", args: [[]], expected: 0 },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function average(nums: number[]): number {\n  if (!nums.length) return 0\n  return nums.reduce((a, b) => a + b, 0) / nums.length\n}\n",
    },
  ),
  C(
    "dbg-10-unique-words",
    "debugging",
    2,
    "Count distinct words case-insensitively over messy whitespace.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function countUniqueWords(text: string): number {\n  return new Set(text.split(' ')).size\n}\n",
    },
    {
      properties: [
        { fn: "countUniqueWords", args: ["a A b"], expected: 2 },
        { fn: "countUniqueWords", args: ["  hello   world hello "], expected: 2 },
        { fn: "countUniqueWords", args: [""], expected: 0 },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function countUniqueWords(text: string): number {\n  const words = text.toLowerCase().split(/\\s+/).filter((w) => w.length > 0)\n  return new Set(words).size\n}\n",
    },
  ),
  C(
    "dbg-11-numeric-sort",
    "debugging",
    1,
    "Sort numbers by value, not lexicographically.",
    "src/solution.ts",
    {
      "src/solution.ts": "export function sortNumbers(nums: number[]): number[] {\n  return [...nums].sort()\n}\n",
    },
    {
      properties: [
        { fn: "sortNumbers", args: [[10, 9, 80]], expected: [9, 10, 80] },
        { fn: "sortNumbers", args: [[3, 1, 2]], expected: [1, 2, 3] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function sortNumbers(nums: number[]): number[] {\n  return [...nums].sort((a, b) => a - b)\n}\n",
    },
  ),
  C(
    "dbg-12-forgotten-await",
    "debugging",
    2,
    "Await the loader before reducing; the seed reduces a promise.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export async function sumLoaded(load: () => Promise<number[]>): Promise<number> {\n  const data = load() as unknown as number[]\n  return data.reduce((a, b) => a + b, 0)\n}\n",
    },
    {
      properties: [
        { fn: "sumLoaded", args: [() => Promise.resolve([1, 2, 3])], expected: 6 },
        { fn: "sumLoaded", args: [() => Promise.resolve([])], expected: 0 },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export async function sumLoaded(load: () => Promise<number[]>): Promise<number> {\n  const data = await load()\n  return data.reduce((a, b) => a + b, 0)\n}\n",
    },
  ),
  C(
    "dbg-13-page-one-based",
    "debugging",
    2,
    "1-based pagination; the seed slices 0-based.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function page(items: number[], pageNum: number, size: number): number[] {\n  return items.slice(pageNum * size, pageNum * size + size)\n}\n",
    },
    {
      properties: [
        { fn: "page", args: [[1, 2, 3, 4, 5], 1, 2], expected: [1, 2] },
        { fn: "page", args: [[1, 2, 3, 4, 5], 3, 2], expected: [5] },
        { fn: "page", args: [[1, 2], 5, 2], expected: [] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function page(items: number[], pageNum: number, size: number): number[] {\n  return items.slice((pageNum - 1) * size, (pageNum - 1) * size + size)\n}\n",
    },
  ),
  C(
    "dbg-14-config-match",
    "debugging",
    2,
    "Compare configs independent of key order; the seed stringifies.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function configsMatch(a: Record<string, number>, b: Record<string, number>): boolean {\n  return JSON.stringify(a) === JSON.stringify(b)\n}\n",
    },
    {
      properties: [
        {
          fn: "configsMatch",
          args: [
            { x: 1, y: 2 },
            { y: 2, x: 1 },
          ],
          expected: true,
        },
        { fn: "configsMatch", args: [{ x: 1 }, { x: 2 }], expected: false },
        { fn: "configsMatch", args: [{ x: 1 }, { x: 1, y: 2 }], expected: false },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function configsMatch(a: Record<string, number>, b: Record<string, number>): boolean {\n  const ka = Object.keys(a).sort()\n  const kb = Object.keys(b).sort()\n  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[kb[i]!])\n}\n",
    },
  ),
]
