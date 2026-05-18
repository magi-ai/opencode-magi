import { cp, mkdir } from "node:fs/promises"

await mkdir("dist/prompts", { recursive: true })
await cp("src/prompts/templates", "dist/prompts/templates", {
  recursive: true,
})
await mkdir("dist/permissions", { recursive: true })
await cp("src/permissions", "dist/permissions", { recursive: true })
