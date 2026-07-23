import type { Config } from "."
import type { Exec } from "@/utils"
import { describe, expect, test, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/constant"
import { validateConfig } from "./validate"

function createConfig(): Config.Root {
  const config = structuredClone(DEFAULT_CONFIG)

  config.account = "single-account"
  config.github.owner = "magi-ai"
  config.github.repo = "opencode-magi"

  return config
}

function createReviewer(id: string, account?: string): Config.Reviewer {
  return {
    account,
    id,
    model: { id: "provider/model" },
  }
}

function createVoter(id: string, account?: string): Config.Voter {
  return createReviewer(id, account)
}

interface SchemaValidator {
  (value: unknown): boolean
  errors?: { instancePath: string; message?: string }[]
}

describe("validate", () => {
  describe("validateConfig", () => {
    test("accepts a valid single-agent config", async () => {
      await expect(validateConfig(createConfig())).resolves.toStrictEqual([])
    })

    test("reports schema errors and skips authentication", async () => {
      const config = createConfig()
      const exec = vi.fn<Exec>()

      config.github.retryApiAttempts = -1
      Object.assign(config, { unexpected: true })

      const errors = await validateConfig(config, { exec })

      expect(errors).toContain(
        "schema config: must NOT have additional properties",
      )
      expect(errors).toContain("schema /github/retryApiAttempts: must be >= 0")
      expect(exec).not.toHaveBeenCalled()
    })

    test("allows GitHub fields to be optional", async () => {
      const config = createConfig()

      config.github.owner = ""
      config.github.repo = ""

      const errors = await validateConfig(config, {
        require: { github: false },
      })

      expect(errors).toContain(
        "schema /github/owner: must NOT have fewer than 1 characters",
      )
      expect(errors).toContain(
        "schema /github/repo: must NOT have fewer than 1 characters",
      )
      expect(errors).not.toContain("github.owner is required")
      expect(errors).not.toContain("github.repo is required")
    })

    test("reports explicitly required agent groups", async () => {
      await expect(
        validateConfig(createConfig(), {
          require: {
            creator: true,
            editor: true,
            reviewers: true,
            voters: true,
          },
        }),
      ).resolves.toStrictEqual([
        "review.reviewers is required",
        "merge.editor is required",
        "merge.editor.model is required",
        "merge.editor.author is required",
        "triage.voters is required",
        "triage.creator is required",
        "triage.creator.model is required",
        "triage.creator.author is required",
      ])
    })

    test("requires fields for configured agent groups", async () => {
      const config = createConfig()

      config.review.reviewers = [
        { id: "reviewer-1", ref: "reviewer-ref-1" },
        { id: "reviewer-2", ref: "reviewer-ref-2" },
        { id: "reviewer-3", ref: "reviewer-ref-3" },
      ]
      config.merge.editor = { ref: "editor-ref" }
      config.triage.voters = [
        { id: "voter-1", ref: "voter-ref-1" },
        { id: "voter-2", ref: "voter-ref-2" },
        { id: "voter-3", ref: "voter-ref-3" },
      ]
      config.triage.creator = { ref: "creator-ref" }

      await expect(validateConfig(config)).resolves.toStrictEqual([
        "review.reviewers[0].model is required",
        "review.reviewers[1].model is required",
        "review.reviewers[2].model is required",
        "merge.editor.model is required",
        "merge.editor.author is required",
        "triage.voters[0].model is required",
        "triage.voters[1].model is required",
        "triage.voters[2].model is required",
        "triage.creator.model is required",
        "triage.creator.author is required",
      ])
    })

    test("requires agent accounts in multi-agent mode", async () => {
      const config = createConfig()

      config.mode = "multi"
      config.review.reviewers = [
        createReviewer("reviewer-1"),
        createReviewer("reviewer-2"),
        createReviewer("reviewer-3"),
      ]
      config.merge.editor = {
        author: { email: "editor@example.com", name: "Editor" },
        model: { id: "provider/model" },
        ref: "editor-ref",
      }
      config.triage.voters = [
        createVoter("voter-1"),
        createVoter("voter-2"),
        createVoter("voter-3"),
      ]
      config.triage.creator = {
        author: { email: "creator@example.com", name: "Creator" },
        model: { id: "provider/model" },
        ref: "creator-ref",
      }

      await expect(validateConfig(config)).resolves.toStrictEqual([
        "review.reviewers[0].account is required",
        "review.reviewers[1].account is required",
        "review.reviewers[2].account is required",
        "merge.editor.account is required",
        "triage.voters[0].account is required",
        "triage.voters[1].account is required",
        "triage.voters[2].account is required",
        "triage.creator.account is required",
      ])
    })

    test("reports group parity, duplicate IDs, and invalid operators", async () => {
      const config = createConfig()

      config.review.reviewers = [
        createReviewer("reviewer-1"),
        createReviewer("reviewer-1"),
        createReviewer("reviewer-2"),
        createReviewer("reviewer-3"),
      ]
      config.review.operator = "missing-reviewer"
      config.triage.voters = [
        createVoter("voter-1"),
        createVoter("voter-1"),
        createVoter("voter-2"),
      ]
      config.triage.operator = "missing-voter"

      await expect(validateConfig(config)).resolves.toStrictEqual([
        "review.reviewers must contain an odd number of agents",
        "review.reviewers has duplicate id: reviewer-1",
        "review.operator must match a configured review reviewer id",
        "triage.voters has duplicate id: voter-1",
        "triage.operator must match a configured triage voter id",
      ])
    })

    test("accepts valid operators and odd agent groups", async () => {
      const config = createConfig()

      config.review.reviewers = [
        createReviewer("reviewer-1"),
        createReviewer("reviewer-2"),
        createReviewer("reviewer-3"),
      ]
      config.review.operator = "reviewer-2"
      config.triage.voters = [
        createVoter("voter-1"),
        createVoter("voter-2"),
        createVoter("voter-3"),
      ]
      config.triage.operator = "voter-2"

      await expect(validateConfig(config)).resolves.toStrictEqual([])
    })

    test("authenticates the single configured account", async () => {
      const config = createConfig()
      const exec = vi.fn<Exec>().mockResolvedValue("token")

      await expect(validateConfig(config, { exec })).resolves.toStrictEqual([])
      expect(exec).toHaveBeenCalledWith(
        'gh auth token --user "single-account"',
        undefined,
      )
    })

    test("reports a single account authentication failure", async () => {
      const config = createConfig()
      const exec = vi.fn<Exec>().mockRejectedValue(new Error("not logged in"))

      await expect(validateConfig(config, { exec })).resolves.toStrictEqual([
        "Account is not authenticated: single-account",
      ])
      expect(exec).toHaveBeenCalledTimes(1)
    })

    test("skips authentication without multi-agent accounts", async () => {
      const config = createConfig()
      const exec = vi.fn<Exec>()

      config.mode = "multi"

      await expect(validateConfig(config, { exec })).resolves.toStrictEqual([])
      expect(exec).not.toHaveBeenCalled()
    })

    test("authenticates every multi-agent account", async () => {
      const config = createConfig()
      const exec = vi.fn<Exec>().mockResolvedValue("token")

      config.mode = "multi"
      config.review.reviewers = [
        createReviewer("reviewer-1", "review-account-1"),
        createReviewer("reviewer-2", "review-account-2"),
        createReviewer("reviewer-3", "review-account-3"),
      ]
      config.merge.editor = {
        account: "editor-account",
        author: { email: "editor@example.com", name: "Editor" },
        model: { id: "provider/model" },
      }
      config.triage.voters = [
        createVoter("voter-1", "voter-account-1"),
        createVoter("voter-2", "voter-account-2"),
        createVoter("voter-3", "voter-account-3"),
      ]
      config.triage.creator = {
        account: "creator-account",
        author: { email: "creator@example.com", name: "Creator" },
        model: { id: "provider/model" },
      }

      await expect(validateConfig(config, { exec })).resolves.toStrictEqual([])
      expect(exec.mock.calls.map(([command]) => command)).toStrictEqual([
        'gh auth token --user "review-account-1"',
        'gh auth token --user "review-account-2"',
        'gh auth token --user "review-account-3"',
        'gh auth token --user "voter-account-1"',
        'gh auth token --user "voter-account-2"',
        'gh auth token --user "voter-account-3"',
        'gh auth token --user "editor-account"',
        'gh auth token --user "creator-account"',
      ])
    })

    test("reports duplicate multi-agent accounts", async () => {
      const config = createConfig()
      const exec = vi.fn<Exec>().mockResolvedValue("token")

      config.mode = "multi"
      config.review.reviewers = [
        createReviewer("reviewer-1", "shared-account"),
        createReviewer("reviewer-2", "review-account-2"),
        createReviewer("reviewer-3", "review-account-3"),
      ]
      config.triage.voters = [
        createVoter("voter-1", "shared-account"),
        createVoter("voter-2", "voter-account-2"),
        createVoter("voter-3", "voter-account-3"),
      ]

      await expect(validateConfig(config, { exec })).resolves.toStrictEqual([
        "triage.voters[0] has duplicate account: shared-account",
      ])
      expect(exec).toHaveBeenCalledTimes(5)
      expect(exec).toHaveBeenCalledWith(
        'gh auth token --user "shared-account"',
        undefined,
      )
    })

    test("formats incomplete schema validation errors", async () => {
      let schemaValidator: SchemaValidator | undefined

      vi.resetModules()
      vi.doMock("ajv/dist/2020", () => ({
        Ajv2020: class AjvMock {
          public readonly mocked = true

          public compile(): SchemaValidator {
            const validate = (() => false) as SchemaValidator

            schemaValidator = validate

            return validate
          }
        },
      }))

      try {
        const { validateConfig: validateWithMock } = await import("./validate")

        schemaValidator!.errors = [{ instancePath: "" }]

        await expect(validateWithMock(createConfig())).resolves.toContain(
          "schema config: invalid value",
        )

        schemaValidator!.errors = undefined

        await expect(validateWithMock(createConfig())).resolves.toStrictEqual(
          [],
        )
      } finally {
        vi.doUnmock("ajv/dist/2020")
        vi.resetModules()
      }
    })
  })
})
