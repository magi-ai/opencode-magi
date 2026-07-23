vi.mock("@opencode-ai/sdk/v2", () => ({
  createOpencodeClient: vi.fn(() => ({
    config: { providers: vi.fn() },
    provider: { list: vi.fn() },
  })),
}))
