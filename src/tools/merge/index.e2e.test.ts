import type { ToolContext } from "@opencode-ai/plugin"
import type { Event, State } from "@/magi"
import { access, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "#/fixtures/magi"
import {
  createGitHubFixture,
  createPullRequestConfig,
  createPullRequestExec,
  createPullRequestMetadata,
  createRepository,
  PULL_REQUEST,
  REVIEWERS,
} from "#/fixtures/pull-request"
import { marker } from "@/utils"
import { merge } from "."

async function readEvents(output: string): Promise<Event[]> {
  return (await readFile(join(output, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Event)
}

describe("magi:merge", () => {
  describe.each(["single", "multi"] as const)("%s mode", (mode) => {
    test("completes an approved run without an edit cycle", async ({
      createMagi,
      temporaryDirectory,
    }) => {
      const repository = await createRepository(temporaryDirectory)
      const config = createPullRequestConfig(temporaryDirectory, mode)
      const github = createGitHubFixture(
        createPullRequestMetadata(temporaryDirectory, repository),
        PULL_REQUEST,
      )
      const { client, magi } = createMagi({ directory: temporaryDirectory })
      const ghCommands: string[] = []
      const rawReview = JSON.stringify({ verdict: "APPROVED" })
      const context = {
        abort: new AbortController().signal,
        sessionID: "parent-session",
      } as ToolContext

      magi.exec = createPullRequestExec(repository, PULL_REQUEST, ghCommands)
      client.session.create
        .mockResolvedValueOnce({ data: { id: "reviewer-one-session" } })
        .mockResolvedValueOnce({ data: { id: "reviewer-two-session" } })
        .mockResolvedValueOnce({ data: { id: "reviewer-three-session" } })
        .mockResolvedValueOnce({ data: { id: "operator-session" } })
      client.session.prompt.mockResolvedValue({
        data: { parts: [{ text: rawReview, type: "text" }] },
      })

      const getConfig = vi.spyOn(magi, "getConfig").mockResolvedValue(config)
      const createOctokit = vi
        .spyOn(magi, "createOctokit")
        .mockResolvedValue(github.octokit)
      const createGraphql = vi
        .spyOn(magi, "createGraphql")
        .mockReturnValue(github.graphql)
      const mergeTool = merge(magi).magi_merge

      if (!mergeTool) throw new Error("Merge tool not found.")

      const result = await mergeTool.execute(
        { prs: PULL_REQUEST.number.toString() },
        context,
      )

      if (typeof result !== "string")
        throw new Error("Merge tool did not return a report.")

      const report = result
      const numberOutput = join(
        config.review.output,
        PULL_REQUEST.number.toString(),
      )
      const entries = await readdir(numberOutput, { withFileTypes: true })
      const runs = entries.filter((entry) => entry.isDirectory())

      expect(runs).toHaveLength(1)

      const output = join(numberOutput, runs[0]!.name)
      const state = JSON.parse(
        await readFile(join(output, "state.json"), "utf8"),
      ) as State
      const events = await readEvents(output)
      const persistedReport = await readFile(join(output, "report.md"), "utf8")

      expect(getConfig).toHaveBeenCalledWith({ editor: true, reviewers: true })
      expect(createOctokit).toHaveBeenCalledTimes(mode === "single" ? 2 : 4)
      expect(createGraphql).toHaveBeenCalledTimes(mode === "single" ? 2 : 4)
      expect(client.session.create).toHaveBeenCalledTimes(4)
      expect(client.session.prompt).toHaveBeenCalledTimes(3)
      expect(client.session.prompt.mock.calls[0]![0].parts[0]!.text).toContain(
        "<output_contract>",
      )
      expect(github.createReview).toHaveBeenCalledTimes(
        mode === "single" ? 1 : 3,
      )
      expect(github.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "APPROVE",
          owner: PULL_REQUEST.owner,
          pull_number: PULL_REQUEST.number,
          repo: PULL_REQUEST.repo,
        }),
      )

      const reviewBodies = github.createReview.mock.calls
        .map(([input]) => input.body)
        .join("\n")

      for (const reviewer of REVIEWERS)
        expect(reviewBodies).toContain(
          marker.stringify({
            command: "review",
            reviewer,
            verdict: "APPROVED",
          }),
        )

      expect(ghCommands).toStrictEqual([
        "gh pr checks 123 --repo 'magi-ai/opencode-magi' --json name,state,bucket,link,workflow --required",
        "gh pr checkout 123 --detach",
      ])
      expect(state.command).toBe("merge")
      expect(state.status).toBe("completed")
      expect(state.pr?.verdict).toBe("APPROVED")
      expect(state.pr?.automation).toBe("SKIPPED")
      expect(state.pr?.files).toStrictEqual(["reviewed.txt"])
      expect(state.editor?.account).toBe(
        mode === "single" ? "review-bot" : "editor-account",
      )
      expect(state.editor?.outputs).toBeUndefined()

      for (const reviewer of REVIEWERS) {
        expect(state.reviewers?.[reviewer]?.outputs).toStrictEqual([
          { verdict: "APPROVED" },
        ])
        expect(state.reviewers?.[reviewer]?.posted).toBe(
          "https://github.com/magi-ai/opencode-magi/pull/123#review",
        )
        await expect(
          readFile(join(output, `${reviewer}-review-1-1.md`), "utf8"),
        ).resolves.toBe(rawReview)
      }

      expect(events.map(({ message }) => message)).toStrictEqual(
        expect.arrayContaining([
          "Started merging.",
          "Checking PR.",
          "Finished checking PR.",
          "Fetching existing reviews.",
          "Finished fetching existing reviews.",
          "Checking CI.",
          "Finished checking CI.",
          "Creating worktree.",
          "Finished creating worktree.",
          "Fetching review context.",
          "Finished fetching review context.",
          "Reviewing.",
          "Running review with reviewer reviewer-one.",
          "Running review with reviewer reviewer-two.",
          "Running review with reviewer reviewer-three.",
          "Finished reviewing.",
          "Final verdict is APPROVED.",
          "Posting reviews.",
          "Finished posting reviews.",
          "Skipped merge automation.",
        ]),
      )
      expect(persistedReport).toBe(`${report}\n`)
      expect(report).toContain("- **Status**: Completed")
      expect(report).toContain("- **Verdict**: Approved")
      expect(report).toContain("- **Automation**: Skipped")
      expect(report).not.toContain("- **Editor**:")
      expect(state.worktree?.path).toBeTypeOf("string")
      await expect(access(state.worktree!.path)).rejects.toMatchObject({
        code: "ENOENT",
      })
    })
  })
})
