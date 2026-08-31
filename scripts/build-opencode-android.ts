#!/usr/bin/env bun
// Bundle opencode for aarch64-android using official Bun (>= 1.4.0, which
// supports --target=bun-linux-aarch64-android).
//
// opencode's own script/build.ts allTargets[] only lists arm64/x64 for
// linux/darwin/win32 and has NO android entry, so we reproduce that bundle
// step here pinned to a single android target instead of patching the
// upstream source. Runs with cwd = packages/opencode.

import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = process.env.OPENCODE_PKG_DIR ?? path.resolve(__dirname, "..")
process.chdir(dir)

import { Script } from "@opencode-ai/script"
import pkg from "../package.json"

const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  await $`OPENCODE_CHANNEL=${Script.channel} bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()
const generated = await import("./generate.ts")
const treeSitterWorker = await Bun.file(
  fileURLToPath(import.meta.resolve("@opentui/core/parser.worker")),
).text()

const name = `opencode-linux-aarch64-android`
const workerPath = "./src/cli/tui/worker.ts"
const treeSitterWorkerPath = "opentui-tree-sitter-worker.js"
const bunfsRoot = "/$bunfs/root/"

await $`rm -rf dist/${name}`

await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
await $`bun install --os="*" --cpu="*" @ff-labs/fff-bun@${pkg.dependencies["@ff-labs/fff-bun"]}`

console.log(`building ${name}`)
await $`mkdir -p dist/${name}/bin`

await Bun.build({
  conditions: ["bun", "node"],
  tsconfig: "./tsconfig.json",
  plugins: [plugin],
  external: ["node-gyp"],
  format: "esm",
  minify: true,
  sourcemap: sourcemapsFlag ? "linked" : "none",
  splitting: true,
  compile: {
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: true,
    autoloadPackageJson: true,
    target: "bun-linux-aarch64-android" as any,
    outfile: `dist/${name}/bin/opencode`,
    execArgv: [`--user-agent=opencode/${Script.version}`, "--use-system-ca", "--"],
    windows: {},
  },
  files: {
    [treeSitterWorkerPath]: treeSitterWorker,
    ...(embeddedFileMap ? { "opencode-web-ui.gen.ts": embeddedFileMap } : {}),
  },
  entrypoints: [
    "./src/index.ts",
    workerPath,
    treeSitterWorkerPath,
    ...(embeddedFileMap ? ["opencode-web-ui.gen.ts"] : []),
  ],
  define: {
    FFF_LIBC: JSON.stringify("gnu"),
    OPENCODE_VERSION: `'${Script.version}'`,
    OPENCODE_MODELS_DEV: generated.modelsData,
    OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + treeSitterWorkerPath,
    OPENCODE_WORKER_PATH: workerPath,
    OPENCODE_CHANNEL: `'${Script.channel}'`,
    OPENCODE_LIBC: `"glibc"`,
    "process.env.OPENTUI_LIBC": JSON.stringify("glibc"),
  },
})

console.log(`done: dist/${name}/bin/opencode`)
