import { writeFileSync } from "node:fs"
import path from "node:path"

// Minimal v2 plugin used by the CI verification job (tests/v2-plugin/verify.sh).
//
// It deliberately imports nothing from `@opencode-ai/plugin`: the point of the
// check is to prove the server's own plugin host can load a directory plugin,
// run its setup, and hand it the tool editor context. Zero-import keeps the
// environment (registry, agent init) out of the equation.
//
// As a hard proof of activation, setup writes a sentinel file. The verify script
// asserts both that the sentinel exists and that /api/plugin lists this plugin
// as active.
const SENTINEL = process.env.V2_PLUGIN_SENTINEL
if (!SENTINEL) throw new Error("V2_PLUGIN_SENTINEL is not set")

export default {
  id: "hello-v2",
  async setup(ctx) {
    writeFileSync(SENTINEL, "setup-ran", "utf8")
    const registration = await ctx.tool.transform((editor) => {
      editor.add({
        name: "hello_v2_world",
        description: "writes a greeting as tool output",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: "hello from v2 plugin" }),
      })
    })
    writeFileSync(`${SENTINEL}.tool`, "registered", "utf8")
    return async () => {
      writeFileSync(`${SENTINEL}.cleanup`, "ran", "utf8")
      // Keep the tool registration alive for the duration of the process: a
      // cleanup that disposes immediately would unregister the tool. The verify
      // script reads the sentinel before the server is stopped, so disposing on
      // shutdown is fine and is exercised by the trap path.
      await registration.dispose()
    }
  },
}