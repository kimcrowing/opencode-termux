#!/usr/bin/env bun
// Bundle OpenCode v2 (`opencode2`) for aarch64-android.
//
// Why this script exists
// ----------------------
// packages/cli/script/build.ts has an `allTargets` array that lists only
// linux/darwin/win32 for arm64/x64 - there is no android entry - and its
// `Target` type has no `abi: "android"`. Rather than patching upstream source
// (which would need re-applying on every rebase), we reproduce the bundle step
// here pinned to a single android target. This is the same approach v1's
// build-opencode-android.ts takes.
//
// Run inside the upstream checkout (copy into packages/cli/script/):
//   OPENCODE_PKG_DIR=<checkout>/packages/cli \
//     bun run script/build-opencode2.ts [--skip-web-ui]
//
// The three things Android needs that upstream doesn't do
// -------------------------------------------------------
// 1. compile.target = "bun-linux-aarch64-android"
//    Bun >= 1.4 ships bun-linux-aarch64-android.zip, so this target exists even
//    though opencode never enumerates it.
//
// 2. OTUI_ASSET_ROOT (runtime, see termux/start-opencode2.sh)
//    @opentui/core has no android prebuild. At runtime it calls
//    resolveNativeLibraryPath(), which first checks
//    $OTUI_ASSET_ROOT/@opentui/core-linux-arm64/libopentui.so and only falls
//    back to importing @opentui/core-<platform>-<arch> - which would throw on
//    Android. scripts/build-opentui.sh produces that asset tree.
//
// 3. No embedded opencode-pty
//    @opencode-ai/pty ships darwin/linux (x64,arm64)x(gnu,musl) only. We pass
//    no pty binding, so pty-binding.ts exports undefined and
//    persistent-pty/binary.bun.ts falls back to looking for `opencode-pty` on
//    PATH. See docs for the follow-up that cross-compiles it.

import { $ } from "bun"
import path from "path"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const skipWebUi = process.argv.includes("--skip-web-ui")
const sourcemaps = process.argv.includes("--sourcemaps")

// packages/cli is the v2 entry package (v1 used packages/opencode).
const dir = process.env.OPENCODE_PKG_DIR ?? path.resolve(import.meta.dirname, "..")
process.chdir(dir)

const { Script } = await import("@opencode-ai/script")

const name = "opencode2-linux-aarch64-android"
const binary = "opencode2"
const solidPlugin = createSolidTransformPlugin()

// ---------------------------------------------------------------------------
// Web UI (packages/app, a Vite build) - embedded as a brotli archive
// ---------------------------------------------------------------------------
// Skipping this is the single biggest lever on peak memory; the TUI works
// without it, so keep it optional for quick iterations.
//
// OPENCODE_APP_ASSETS, when set, points at a prebuilt archive written by
// scripts/build-web-assets.ts (from the separate build-web-assets job). The
// build steps above and this job end in the SAME base64 brotli string, so
// reusing it here skips the Vite build without changing the output.
const buildAppArchive = async () => {
  if (process.env.OPENCODE_APP_ASSETS) {
    const archive = (await Bun.file(process.env.OPENCODE_APP_ASSETS).text()).trim()
    if (archive) return archive
  }
  const { buildAppArchive: build } = await import("./app-assets")
  return build(Script.channel, { skipBuild: skipWebUi })
}

const appPlugin: BunPlugin = {
  name: "opencode-app-assets-android",
  setup(build) {
    build.onResolve({ filter: /^virtual:opencode-app-assets$/ }, () => ({
      path: "opencode-app-assets",
      namespace: "opencode-android",
    }))
    build.onLoad({ filter: /^opencode-app-assets$/, namespace: "opencode-android" }, async () => ({
      loader: "js",
      contents: `export default ${JSON.stringify(await buildAppArchive())}`,
    }))
  },
}

// ---------------------------------------------------------------------------
// opencode-pty: no android artifact exists, so bind nothing
// ---------------------------------------------------------------------------
// Upstream injects the real binary here. We export undefined, which makes the
// runtime fall back to PATH lookup (and to OPENCODE_PTY_BIN when set).
const ptyPlugin: BunPlugin = {
  name: "opencode-pty-android",
  setup(build) {
    build.onLoad({ filter: /persistent-pty[/\\]pty-binding\.ts$/ }, () => ({
      loader: "js",
      contents: "export default undefined",
    }))
  },
}

// @parcel/watcher has no android prebuild either. Upstream rewrites the binding
// import to a platform package name; there is nothing valid to point it at here,
// so we let it resolve to a stub and rely on the watcher being unused on device.
// TUI/server startup does not require filesystem watching.
const parcelWatcherPlugin: BunPlugin = {
  name: "parcel-watcher-android",
  setup(build) {
    build.onLoad({ filter: /filesystem\/watcher-binding\.ts$/ }, () => ({
      loader: "js",
      contents: `
let binding
try { binding = require("@parcel/watcher") } catch {}
export default () => binding ?? { subscribe() { throw new Error("file watching is unavailable on this build") }, unsubscribe() {} }
`,
    }))
  },
}

// ---------------------------------------------------------------------------
// Native deps
// ---------------------------------------------------------------------------
// The workflow already runs `bun install --os="*" --cpu="*"` at the checkout
// root, which installs every workspace dependency including the platform
// optional packages (@opentui/core-*, @parcel/watcher-*). Nothing extra to
// install here; the android bundle just needs the JS entries to resolve, and
// the native .so is supplied at runtime via OTUI_ASSET_ROOT.

await $`rm -rf dist/${name}`
await $`mkdir -p dist/${name}/bin`

console.log(`building ${name}`)

// Bun respects BUN_JSC_gcMaxHeapSize (bytes) to bound its heap; the workflow
// sets it via env. Do not assign BUN_JSC_heapSize here - it is not a valid
// option name and bun 1.4.1 rejects it at startup.

const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  tsconfig: "./tsconfig.json",
  plugins: [solidPlugin, appPlugin, ptyPlugin, parcelWatcherPlugin],
  external: ["node-gyp"],
  format: "esm",
  minify: true,
  bytecode: true,
  sourcemap: sourcemaps ? "linked" : "none",
  splitting: true,
  compile: {
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: true,
    autoloadPackageJson: true,
    target: "bun-linux-aarch64-android" as Bun.Build.CompileTarget,
    outfile: path.join("dist", name, "bin", binary),
    execArgv: [`--user-agent=opencode/${Script.channel}/${Script.version}/cli`, "--use-system-ca", "--"],
    windows: {},
  },
  define: {
    OPENCODE_VERSION: `'${Script.version}'`,
    OPENCODE_CLI_NAME: `'${binary}'`,
    OPENCODE_CHANNEL: `'${Script.channel}'`,
    OPENCODE_ARTIFACT: `'cli'`,
    // Report glibc on Android: bionic is closest to glibc of the two values
    // opencode understands, and this only feeds telemetry/asset selection.
    OPENCODE_LIBC: `'glibc'`,
    "process.env.OPENTUI_LIBC": JSON.stringify("glibc"),
  },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

// The npm package that installs this binary must claim the right platform.
// Android is not a valid npm `os` value upstream uses, but bun itself publishes
// os=android/abi=android, so mirror that (see oven-sh/bun platform.ts).
await Bun.write(
  path.join("dist", name, "package.json"),
  JSON.stringify(
    {
      name: `@opencode-ai/${name}`,
      version: Script.version,
      license: "MIT",
      repository: { type: "git", url: "git+https://github.com/anomalyco/opencode.git" },
      os: ["android"],
      cpu: ["arm64"],
    },
    null,
    2,
  ),
)

console.log(`done: dist/${name}/bin/${binary}`)
