import { vi } from "vitest"

vi.mock("@opencode-ai/sdk/v2", () => ({
  createOpencodeClient: vi.fn(),
}))
