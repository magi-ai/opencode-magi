import type {
  PluginInput as OriginalPluginInput,
  PluginOptions,
} from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { test as base, vi } from "vitest"
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
  directory?: string
  fetch?: typeof globalThis.fetch
  options?: PluginOptions
}

export interface CreateMagi {
  (options?: CreateMagiOptions): MagiFixture
}

interface Fixtures {
  createMagi: CreateMagi
  magiFixture: MagiFixture
  temporaryDirectory: string
}

const createOpencodeClientMock = vi.mocked(createOpencodeClient)

function instantiateMagi({
  directory = "/test",
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
    directory,
    serverUrl: new URL("http://localhost"),
  } as unknown as OriginalPluginInput

  createOpencodeClientMock.mockReturnValue(
    client as unknown as ReturnType<typeof createOpencodeClient>,
  )

  return { client, magi: new Magi(input, options) }
}

export const test = base.extend<Fixtures>({
  createMagi: async ({ task: _task }, use) => {
    createOpencodeClientMock.mockReset()

    await use(instantiateMagi)
  },
  magiFixture: async ({ createMagi }, use) => {
    await use(createMagi())
  },
  temporaryDirectory: async ({ task: _task }, use) => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-magi-test-"))

    try {
      await use(directory)
    } finally {
      await rm(directory, {
        force: true,
        recursive: true,
      })
    }
  },
})
