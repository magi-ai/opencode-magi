import type {
  PluginInput as OriginalPluginInput,
  PluginOptions,
} from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
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
  question: {
    reject: ReturnType<typeof vi.fn>
  }
  session: {
    abort: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
    prompt: ReturnType<typeof vi.fn>
  }
}

export interface MagiFixture {
  client: ClientMocks
  magi: Magi
}

export interface CreateMagiOptions {
  dir?: string
  fetch?: typeof globalThis.fetch
  options?: PluginOptions
}

export interface CreateMagi {
  (options?: CreateMagiOptions): MagiFixture
}

interface Fixtures extends MagiFixture {
  createMagi: CreateMagi
  tmpDir: string
}

const createOpencodeClientMock = vi.mocked(createOpencodeClient)

function instantiateMagi({
  dir = "/test",
  fetch,
  options,
}: CreateMagiOptions = {}): MagiFixture {
  const client: ClientMocks = {
    event: {
      subscribe: vi.fn().mockResolvedValue({ stream: Readable.from([]) }),
    },
    permission: {
      reply: vi.fn(),
    },
    question: {
      reject: vi.fn(),
    },
    session: {
      abort: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      prompt: vi.fn(),
    },
  }
  const input = {
    client: {
      session: {
        _client: {
          getConfig: () => ({ fetch }),
        },
      },
    },
    directory: dir,
    serverUrl: new URL("http://localhost"),
  } as unknown as OriginalPluginInput

  createOpencodeClientMock.mockReturnValue(
    client as unknown as ReturnType<typeof createOpencodeClient>,
  )

  return { client, magi: new Magi(input, options) }
}

export const test = base.extend<Fixtures>({
  client: async ({ magi }, use) => {
    await use(magi.input.client as unknown as ClientMocks)
  },
  createMagi: async ({ task: _task }, use) => {
    createOpencodeClientMock.mockReset()

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
