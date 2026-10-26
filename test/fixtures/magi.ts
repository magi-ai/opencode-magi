import type { Plugin, PluginOptions } from "@opencode/plugin"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { test as base } from "vitest"
import { Magi } from "@/magi"

export interface ClientMocks {
  event: {
    subscribe: ReturnType<typeof vi.fn>
  }
  permission: {
    reply: ReturnType<typeof vi.fn>
  }
  session: {
    context: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    interrupt: ReturnType<typeof vi.fn>
    prompt: ReturnType<typeof vi.fn>
    remove: ReturnType<typeof vi.fn>
    wait: ReturnType<typeof vi.fn>
  }
}

export interface MagiFixture {
  client: ClientMocks
  magi: Magi
}

export interface CreateMagiOptions {
  dir?: string
  options?: PluginOptions
}

export interface CreateMagi {
  (options?: CreateMagiOptions): MagiFixture
}

interface Fixtures extends MagiFixture {
  createMagi: CreateMagi
  tmpDir: string
}

function instantiateMagi({
  dir = "/test",
  options,
}: CreateMagiOptions = {}): MagiFixture {
  const client: ClientMocks = {
    event: {
      subscribe: vi.fn(() => Readable.from([])),
    },
    permission: {
      reply: vi.fn(),
    },
    session: {
      context: vi.fn(),
      create: vi.fn(),
      interrupt: vi.fn(),
      prompt: vi
        .fn()
        .mockResolvedValue({ id: "prompt-id", time: { created: 1 } }),
      remove: vi.fn(),
      wait: vi.fn(),
    },
  }
  const input = {
    ...client,
    location: { directory: dir },
    options: options ?? {},
  } as unknown as Plugin.Context

  return { client: input as unknown as ClientMocks, magi: new Magi(input) }
}

export const test = base.extend<Fixtures>({
  client: async ({ magi }, use) => {
    await use(magi.input.client as unknown as ClientMocks)
  },
  createMagi: async ({ task: _task }, use) => {
    await use(instantiateMagi)
  },
  magi: async ({ createMagi }, use) => {
    await use(createMagi().magi)
  },
  tmpDir: async ({ task: _task }, use) => {
    const tmpDir = await mkdtemp(join(tmpdir(), "opencode-magi-test-"))

    try {
      await use(tmpDir)
    } finally {
      await rm(tmpDir, {
        force: true,
        recursive: true,
      })
    }
  },
})
