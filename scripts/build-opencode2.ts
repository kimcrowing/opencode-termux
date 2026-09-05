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
// Run with the upstream checkout as the working tree root:
//   OPENCODE_PKG_DIR=<checkout>/packages/cli bun run scripts/build-opencode2.ts
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
const dir = process.env.OPENCODE_PKG_DIR ?? path.resolve(import.meta.dirname, "../../packages/cli")
process.chdir(dir)

const { Script } = await import("@opencode-ai/script")
const pkg = (await import("../package.json")).default

const name = "opencode2-linux-aarch64-android"
const binary = "opencode2"
const solidPlugin = createSolidTransformPlugin()

// ---------------------------------------------------------------------------
// Web UI (packages/app, a Vite build) - embedded as a brotli archive
// ---------------------------------------------------------------------------
// Skipping this is the single biggest lever on peak memory; the TUI works
// without it, so keep it optional for quick iterations.
//
// buildAppArchive(channel, { skipBuild: true }) returns an archive containing no
// assets, which is what we want when --skip-web-ui is passed.
const buildAppArchive = async () => {
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
// Install native deps for all platforms
// ---------------------------------------------------------------------------
// --os/--cpu="*" forces Bun to fetch every optional platform package so the
// android bundle can still resolve @opentui/core's JS entry (its native .so is
// supplied at runtime via OTUI_ASSET_ROOT).
const install = async (spec: string) => {
  console.log(`installing ${spec}`)
  await $`bun install --os="*" --cpu="*" ${spec}`
}

await install(`@opentui/core@${pkg.dependencies["@opentui/core"]}`)
await install(`@opentui/solid@${pkg.dependencies["@opentui/solid"]}`)
if (pkg.dependencies["@parcel/watcher"]) {
  await install(`@parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`)
}

await $`rm -rf dist/${name}`
await $`mkdir -p dist/${name}/bin`

console.log(`building ${name}`)

// Keep Bun's bundler memory in check on small runners.
if (!process.env.BUN_JSC_heapSize) process.env.BUN_JSC_heapSize = "3072"

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
