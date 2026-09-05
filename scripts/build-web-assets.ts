#!/usr/bin/env bun
// Build the embedded web UI archive (packages/app, a Vite build) on its own so
// the opencode2 bundle job can reuse it without re-running Vite every dispatch.
//
// The archive is exactly what packages/cli/script/build.ts embeds: a base64
// string of brotli-compressed JSON mapping dist files to their contents.
// `app-assets.ts` produces it, so this script just delegates there and writes
// the string to a file for the next job to pick up.
//
// Run inside the upstream checkout (copy into packages/cli/script/):
//   OPENCODE_PKG_DIR=<checkout>/packages/cli \
//     OPENCODE_WEB_ASSETS_OUT=<path>/web-assets.b64 \
//     bun run script/build-web-assets.ts [--skip-web-ui]
//
// --skip-web-ui produces the same empty archive upstream embeds for quick
// iterations (compress({})), letting build-opencode2 stay unchanged.
import path from "path"
import { mkdirSync } from "node:fs"
import { Script } from "@opencode-ai/script"
import { buildAppArchive } from "./app-assets"

const skipWebUi = process.argv.includes("--skip-web-ui")
const dir = process.env.OPENCODE_PKG_DIR ?? path.resolve(import.meta.dirname, "..")
process.chdir(dir)

const out =
  process.env.OPENCODE_WEB_ASSETS_OUT ??
  path.join(dir, "dist", "web-assets.b64")
console.log(`web-assets: building archive (skip=${skipWebUi})`)
const archive = await buildAppArchive(Script.channel, { skipBuild: skipWebUi })
mkdirSync(path.dirname(out), { recursive: true })
await Bun.write(out, archive)
console.log(`web-assets: archive -> ${out} (${archive.length} chars)`)