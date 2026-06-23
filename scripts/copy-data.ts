import { cp, mkdir, readdir } from "node:fs/promises"
import { dirname, join } from "node:path"

async function copyData(
  src: string,
  dest: string,
  extensions: string[],
): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true })

  await Promise.all(
    entries.map(async (entry) => {
      const from = join(src, entry.name)
      const to = join(dest, entry.name)

      if (entry.isDirectory()) {
        await copyData(from, to, extensions)
      } else if (
        entry.isFile() &&
        extensions.some((ext) => entry.name.endsWith(ext))
      ) {
        await mkdir(dirname(to), { recursive: true })
        await cp(from, to)
      }
    }),
  )
}

await mkdir("dist/prompts", { recursive: true })
await copyData("src/prompts", "dist/prompts", [".json", ".md"])
await mkdir("dist/permissions", { recursive: true })
await copyData("src/permissions", "dist/permissions", [".json"])
