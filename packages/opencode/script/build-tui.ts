// Pre-compile the TUI entry for npm installs. The host's Solid transform
// skips everything under node_modules, and OpenCode installs npm plugins
// into its cache under node_modules — so raw .tsx cannot ship: Bun falls
// back to react-jsx and the load fails on 'react'. This compiles JSX with
// the same Solid preset the host uses (moduleName @opentui/solid) while
// leaving bare imports (solid-js, @opencode/plugin/*, @opentui/*) intact;
// the host rewrites those to its own instances at load.
import path from "node:path"
import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import solidPreset from "babel-preset-solid"

const root = path.resolve(import.meta.dir, "..")

// Bare specifiers the host provides at load; everything else bundles.
// NOTE: @opencode/plugin/rpc is deliberately bundled, not external: it is a
// pure re-export of schema builders (no host identity), and the host only
// rewrites the specifiers in its runtime map.
const EXTERNAL = [
  "solid-js",
  "solid-js/store",
  "@opencode/plugin/tui",
  "@opentui/solid",
  "@opentui/core",
  "@heretek-ai/es-core",
]

export async function buildTui(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [path.join(root, "src/tui.tsx")],
    outdir: path.join(root, "dist"),
    target: "bun",
    naming: "tui.js",
    external: EXTERNAL,
    plugins: [
      {
        name: "es-solid-tsx",
        setup(build: any) {
          build.onLoad({ filter: /\.tsx$/ }, async (args: any) => {
            const source = await Bun.file(args.path).text()
            const transformed = await transformAsync(source, {
              filename: args.path,
              configFile: false,
              babelrc: false,
              presets: [
                [presetTypescript, { isTSX: true, allExtensions: true }],
                [solidPreset, { moduleName: "@opentui/solid", generate: "universal" }],
              ],
            })
            if (!transformed?.code) throw new Error(`Solid transform produced no output for ${args.path}`)
            return { contents: transformed.code, loader: "js" }
          })
        },
      },
    ],
  })
  if (!result.success) throw new Error(`tui build failed:\n${result.logs.join("\n")}`)
  return path.join(root, "dist", "tui.js")
}

if (import.meta.main) {
  const out = await buildTui()
  console.log(`tui: ok (${out})`)
}
