import { resolve } from "node:path"
import { rm } from "./fs"

const fs = vi.hoisted(() => ({
  originalRm: vi.fn(),
  readdir: vi.fn(),
  rmdir: vi.fn(),
}))

vi.mock("node:fs/promises", () => ({
  readdir: fs.readdir,
  rm: fs.originalRm,
  rmdir: fs.rmdir,
}))

describe("rm", () => {
  afterEach(() => {
    vi.resetAllMocks()
  })

  test("removes the target with the supplied options without pruning by default", async () => {
    fs.originalRm.mockResolvedValue(undefined)

    await rm("target", { force: true, recursive: true })

    expect(fs.originalRm).toHaveBeenCalledWith("target", {
      force: true,
      recursive: true,
    })
    expect(fs.readdir).not.toHaveBeenCalled()
    expect(fs.rmdir).not.toHaveBeenCalled()
  })

  test("prunes empty ancestors in order and stops at a non-empty directory", async () => {
    fs.originalRm.mockResolvedValue(undefined)
    fs.readdir.mockResolvedValueOnce([]).mockResolvedValueOnce(["remaining"])
    fs.rmdir.mockResolvedValue(undefined)

    const parent = resolve(process.cwd(), "root", "parent")
    const root = resolve(process.cwd(), "root")

    await rm(resolve(parent, "target"), { prune: true })

    expect(fs.readdir).toHaveBeenNthCalledWith(1, parent)
    expect(fs.rmdir).toHaveBeenCalledExactlyOnceWith(parent)
    expect(fs.readdir).toHaveBeenNthCalledWith(2, root)
  })

  test("uses a string prune root and never removes that root", async () => {
    fs.originalRm.mockResolvedValue(undefined)
    fs.readdir.mockResolvedValue([])
    fs.rmdir.mockResolvedValue(undefined)

    const root = resolve(process.cwd(), "root")
    const parent = resolve(root, "parent")

    await rm(resolve(parent, "target"), { prune: root })

    expect(fs.readdir).toHaveBeenCalledExactlyOnceWith(parent)
    expect(fs.rmdir).toHaveBeenCalledExactlyOnceWith(parent)
  })

  test("does not inspect ancestors outside the prune root", async () => {
    fs.originalRm.mockResolvedValue(undefined)

    const root = resolve(process.cwd(), "root")
    const target = resolve(process.cwd(), "outside", "target")

    await rm(target, { prune: root })

    expect(fs.readdir).not.toHaveBeenCalled()
    expect(fs.rmdir).not.toHaveBeenCalled()
  })

  test("stops pruning when inspecting an ancestor fails", async () => {
    fs.originalRm.mockResolvedValue(undefined)
    fs.readdir.mockRejectedValue(new Error("unavailable"))

    const root = resolve(process.cwd(), "root")

    await expect(
      rm(resolve(root, "parent", "target"), { prune: root }),
    ).resolves.toBeUndefined()
    expect(fs.rmdir).not.toHaveBeenCalled()
  })

  test("propagates target removal errors without attempting to prune", async () => {
    const error = new Error("removal failed")

    fs.originalRm.mockRejectedValue(error)

    await expect(rm("target", { prune: true })).rejects.toBe(error)
    expect(fs.readdir).not.toHaveBeenCalled()
    expect(fs.rmdir).not.toHaveBeenCalled()
  })
})
