import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "#": fileURLToPath(new URL("./test", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    coverage: {
      exclude: ["**/*.generated.ts"],
    },
    globals: true,
    include: ["src/**/*.test.ts"],
    onConsoleLog: (_, type) => type !== "stderr",
    setupFiles: ["./test/setup.ts"],
  },
})
