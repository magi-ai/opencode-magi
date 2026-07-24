import type { ToolContext } from "@opencode-ai/plugin"
import type { ClientMocks } from "#/fixtures/magi"
import type { GitHubFixture, RepositoryFixture } from "#/fixtures/pull-request"
import type { Config } from "@/config"
import type { Event, Magi, State } from "@/magi"
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
import { review } from "."

async function readEvents(output: string): Promise<Event[]> {
  return (await readFile(join(output, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Event)
}

interface RunArtifacts {
  events: Event[]
  output: string
  report: string
  state: State
}

function mockSessions(client: ClientMocks): void {
  client.session.create
    .mockResolvedValueOnce({ data: { id: "reviewer-one-session" } })
    .mockResolvedValueOnce({ data: { id: "reviewer-two-session" } })
    .mockResolvedValueOnce({ data: { id: "reviewer-three-session" } })
    .mockResolvedValueOnce({ data: { id: "operator-session" } })
}

function mockPromptOutputs(client: ClientMocks, outputs: string[]): void {
  client.session.prompt.mockImplementation(() => {
    const text = outputs.shift()

    if (text == null) return Promise.reject(new Error("Prompt output missing."))

    return Promise.resolve({ data: { parts: [{ text, type: "text" }] } })
  })
}

function mockGitHub(magi: Magi, github: GitHubFixture): void {
  vi.spyOn(magi, "createOctokit").mockResolvedValue(github.octokit)
  vi.spyOn(magi, "createGraphql").mockReturnValue(github.graphql)
}

async function executeReview(
  magi: Magi,
  context: ToolContext,
  prs = PULL_REQUEST.number.toString(),
): Promise<string> {
  const reviewTool = review(magi).magi_review

  if (!reviewTool) throw new Error("Review tool not found.")

  const result = await reviewTool.execute({ prs }, context)

  if (typeof result !== "string")
    throw new Error("Review tool did not return a report.")

  return result
}

async function getRunOutput(
  config: Config.Root,
  number: number = PULL_REQUEST.number,
): Promise<string> {
  const numberOutput = join(config.review.output, number.toString())
  const entries = await readdir(numberOutput, { withFileTypes: true })
  const runs = entries.filter((entry) => entry.isDirectory())

  expect(runs).toHaveLength(1)

  return join(numberOutput, runs[0]!.name)
}

async function readRun(config: Config.Root): Promise<RunArtifacts> {
  const output = await getRunOutput(config)

  return {
    events: await readEvents(output),
    output,
    report: await readFile(join(output, "report.md"), "utf8"),
    state: JSON.parse(await readFile(join(output, "state.json"), "utf8")),
  }
}

function createContext(controller = new AbortController()): ToolContext {
  return {
    abort: controller.signal,
    sessionID: "parent-session",
  } as ToolContext
}

function configurePages(
  github: GitHubFixture,
  {
    comments = [],
    commits = [],
    reviews = [],
    threads = [],
  }: {
    comments?: unknown[]
    commits?: unknown[]
    reviews?: unknown[]
    threads?: unknown[]
  },
): void {
  github.octokitPaginate.mockImplementation((request) => {
    if (request === github.listFiles)
      return Promise.resolve([{ filename: "reviewed.txt" }])
    if (request === github.listComments) return Promise.resolve(comments)
    if (request === github.listCommits) return Promise.resolve(commits)
    if (request === github.listReviews) return Promise.resolve(reviews)

    return Promise.reject(new Error("Unexpected Octokit pagination request."))
  })
  github.graphqlPaginate.mockImplementation((request) => {
    if (request === github.closingIssues)
      return Promise.resolve({
        repository: {
          pullRequest: { closingIssuesReferences: { nodes: [] } },
        },
      })
    if (request === github.reviewThreads)
      return Promise.resolve({
        repository: { pullRequest: { reviewThreads: { nodes: threads } } },
      })

    return Promise.reject(new Error("Unexpected GraphQL pagination request."))
  })
}

function approvedOutput(): string {
  return JSON.stringify({ verdict: "APPROVED" })
}

function reviewMarker(reviewer: string, verdict = "APPROVED"): string {
  return marker.stringify({ command: "review", reviewer, verdict })
}

function createReviewExec(
  repository: RepositoryFixture,
  ghCommands: string[],
  handler?: Parameters<typeof createPullRequestExec>[3],
): ReturnType<typeof createPullRequestExec> {
  return createPullRequestExec(repository, PULL_REQUEST, ghCommands, handler)
}

describe("magi:review", () => {
  describe.each(["single", "multi"] as const)("%s mode", (mode) => {
    test("completes an approved review and persists its artifacts", async ({
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
      const reviewTool = review(magi).magi_review

      if (!reviewTool) throw new Error("Review tool not found.")

      const result = await reviewTool.execute(
        { prs: PULL_REQUEST.number.toString() },
        context,
      )

      if (typeof result !== "string")
        throw new Error("Review tool did not return a report.")

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

      expect(getConfig).toHaveBeenCalledWith({ reviewers: true })
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
          owner: "magi-ai",
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
      expect(state.status).toBe("completed")
      expect(state.pr?.verdict).toBe("APPROVED")
      expect(state.pr?.automation).toBe("SKIPPED")
      expect(state.pr?.files).toStrictEqual(["reviewed.txt"])

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
          "Started reviewing.",
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
          "Finished review with reviewer reviewer-one.\n\nVerdict: Approved.",
          "Finished review with reviewer reviewer-two.\n\nVerdict: Approved.",
          "Finished review with reviewer reviewer-three.\n\nVerdict: Approved.",
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
      expect(report).toContain("- **Reviewer**:")
      expect(state.worktree?.path).toBeTypeOf("string")
      await expect(access(state.worktree!.path)).rejects.toMatchObject({
        code: "ENOENT",
      })
    })
  })

  test("blocks unsafe pull requests before creating review resources", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const repository = await createRepository(temporaryDirectory)
    const config = createPullRequestConfig(temporaryDirectory, "single")
    const metadata = createPullRequestMetadata(temporaryDirectory, repository)
    const github = createGitHubFixture(metadata, PULL_REQUEST)
    const { client, magi } = createMagi({ directory: temporaryDirectory })
    const ghCommands: string[] = []

    config.review.safety.allowAuthors = ["trusted-author"]
    config.review.safety.blockedPaths = ["reviewed.txt"]
    config.review.safety.maxChangedFiles = 0
    config.review.safety.requiredLabels = ["ready"]
    magi.exec = createReviewExec(repository, ghCommands)
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    mockGitHub(magi, github)

    await expect(executeReview(magi, createContext())).rejects.toThrow(
      "PR is safety blocked",
    )

    const { report, state } = await readRun(config)

    expect(state.status).toBe("blocked")
    expect(report).toContain("Author is not allowed: author.")
    expect(report).toContain("Required labels missing: ready.")
    expect(report).toContain("Changed files exceed limit: 1 > 0.")
    expect(report).toContain("Blocked paths changed: reviewed.txt.")
    expect(client.session.create).not.toHaveBeenCalled()
    expect(github.createReview).not.toHaveBeenCalled()
    expect(ghCommands).toStrictEqual([])
  })

  test("completes one pull request while reporting another blocked run", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const repository = await createRepository(temporaryDirectory)
    const config = createPullRequestConfig(temporaryDirectory, "single")
    const metadata = createPullRequestMetadata(temporaryDirectory, repository)
    const github = createGitHubFixture(metadata, PULL_REQUEST)
    const { client, magi } = createMagi({ directory: temporaryDirectory })
    const ghCommands: string[] = []

    let session = 0

    config.review.concurrency.runs = 2
    github.get.mockImplementation(({ pull_number }) =>
      Promise.resolve({
        data: pull_number === 124 ? { ...metadata, draft: true } : metadata,
      }),
    )
    magi.exec = async (command, options): Promise<string> => {
      if (!command.startsWith("gh ")) return repository.exec(command, options)

      ghCommands.push(command)

      if (/^gh pr checkout (123|124) --detach$/.test(command))
        return repository.exec(
          `git checkout --detach '${repository.headSha}'`,
          options,
        )
      if (/^gh pr checks (123|124) /.test(command)) return "[]"

      throw new Error(`Unexpected GitHub CLI command: ${command}`)
    }
    client.session.create.mockImplementation(() => {
      session += 1

      return Promise.resolve({ data: { id: `session-${session}` } })
    })
    client.session.prompt.mockResolvedValue({
      data: { parts: [{ text: approvedOutput(), type: "text" }] },
    })
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    mockGitHub(magi, github)

    await expect(
      executeReview(
        magi,
        createContext(),
        "123, https://github.com/magi-ai/opencode-magi/pull/124",
      ),
    ).rejects.toThrow("PR is a draft.")

    const completedOutput = await getRunOutput(config, 123)
    const blockedOutput = await getRunOutput(config, 124)
    const completed = JSON.parse(
      await readFile(join(completedOutput, "state.json"), "utf8"),
    ) as State
    const blocked = JSON.parse(
      await readFile(join(blockedOutput, "state.json"), "utf8"),
    ) as State

    expect(completed.status).toBe("completed")
    expect(completed.pr?.verdict).toBe("APPROVED")
    expect(blocked.status).toBe("blocked")
    expect(github.createReview).toHaveBeenCalledTimes(1)
  })

  test("applies command options to a complete dry-run scenario", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const repository = await createRepository(temporaryDirectory)
    const config = createPullRequestConfig(temporaryDirectory, "single")
    const metadata = createPullRequestMetadata(temporaryDirectory, repository)
    const github = createGitHubFixture(metadata, PULL_REQUEST)
    const { client, magi } = createMagi({ directory: temporaryDirectory })
    const ghCommands: string[] = []

    magi.exec = createReviewExec(repository, ghCommands)
    mockSessions(client)
    mockPromptOutputs(
      client,
      REVIEWERS.map(() => approvedOutput()),
    )
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    mockGitHub(magi, github)

    await expect(
      executeReview(
        magi,
        createContext(),
        [
          "123",
          "--dry-run",
          "--retry-api-attempts 5",
          "--language ja",
          "--merge",
          "--no-merge",
          "--close",
          "--no-close",
          "--retry-failed-jobs 4",
          "--concurrency-reviewers 1",
          "--concurrency-runs 2",
          "--wait-checks",
          "--no-wait-checks",
        ].join(" "),
      ),
    ).resolves.toContain("- **Dry run**: Yes")

    const { state } = await readRun(config)

    expect(config.github.retryApiAttempts).toBe(5)
    expect(config.language).toBe("ja")
    expect(config.review.automation).toStrictEqual({
      close: false,
      merge: false,
    })
    expect(config.review.checks.retryFailedJobs).toBe(4)
    expect(config.review.checks.wait).toBeFalsy()
    expect(config.review.concurrency).toStrictEqual({ reviewers: 1, runs: 2 })
    expect(state.dryRun).toBeTruthy()
    expect(github.createReview).not.toHaveBeenCalled()
  })

  test("reuses current reviews without creating sessions or a worktree", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const repository = await createRepository(temporaryDirectory)
    const config = createPullRequestConfig(temporaryDirectory, "single")
    const metadata = createPullRequestMetadata(temporaryDirectory, repository)
    const github = createGitHubFixture(metadata, PULL_REQUEST)
    const { client, magi } = createMagi({ directory: temporaryDirectory })
    const ghCommands: string[] = []
    const reviewBody = marker.stringify(
      ...REVIEWERS.map((reviewer) => ({
        command: "review",
        reviewer,
        verdict: "APPROVED",
      })),
    )

    configurePages(github, {
      commits: [
        {
          commit: { author: { date: "2026-07-24T00:00:00.000Z" } },
          parents: [{}],
        },
      ],
      reviews: [
        {
          body: reviewBody,
          commit_id: repository.headSha,
          html_url: "https://github.com/magi-ai/opencode-magi/pull/123#review",
          state: "APPROVED",
          submitted_at: "2026-07-24T01:00:00.000Z",
          user: { login: "review-bot" },
        },
      ],
    })
    magi.exec = createReviewExec(repository, ghCommands)
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    mockGitHub(magi, github)

    const result = await executeReview(magi, createContext())
    const { state } = await readRun(config)

    expect(result).toContain("- **Verdict**: Approved")
    expect(state.status).toBe("completed")
    expect(state.worktree).toBeUndefined()
    expect(client.session.create).not.toHaveBeenCalled()
    expect(client.session.prompt).not.toHaveBeenCalled()
    expect(github.createReview).not.toHaveBeenCalled()
    expect(ghCommands).toStrictEqual([
      "gh pr checks 123 --repo 'magi-ai/opencode-magi' --json name,state,bucket,link,workflow --required",
    ])
  })

  test("runs initial and rereview reviewers while preserving a current review", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const repository = await createRepository(temporaryDirectory)
    const config = createPullRequestConfig(temporaryDirectory, "single")
    const metadata = createPullRequestMetadata(temporaryDirectory, repository)
    const github = createGitHubFixture(metadata, PULL_REQUEST)
    const { client, magi } = createMagi({ directory: temporaryDirectory })
    const ghCommands: string[] = []
    const thread = {
      comments: {
        nodes: [
          {
            author: { login: "review-bot" },
            body: reviewMarker("reviewer-one"),
            createdAt: "2026-07-23T00:00:00.000Z",
            databaseId: 7,
          },
        ],
      },
      id: "thread-1",
      isResolved: false,
      line: 2,
      path: "reviewed.txt",
    }

    config.review.concurrency.reviewers = 1
    configurePages(github, {
      commits: [
        {
          commit: { author: { date: "2026-07-24T00:00:00.000Z" } },
          parents: [{}],
        },
      ],
      reviews: [
        {
          body: reviewMarker("reviewer-one"),
          commit_id: repository.baseSha,
          html_url: "https://github.com/review-one",
          state: "APPROVED",
          submitted_at: "2026-07-23T00:00:00.000Z",
          user: { login: "review-bot" },
        },
        {
          body: reviewMarker("reviewer-two"),
          commit_id: repository.headSha,
          html_url: "https://github.com/review-two",
          state: "APPROVED",
          submitted_at: "2026-07-24T01:00:00.000Z",
          user: { login: "review-bot" },
        },
      ],
      threads: [thread],
    })
    magi.exec = createReviewExec(repository, ghCommands)
    mockSessions(client)
    mockPromptOutputs(client, [
      JSON.stringify({
        comment: "Following up on the existing thread.",
        followUps: [{ body: "Can you clarify this?", commentId: 7 }],
        resolves: [{ commentId: 7, threadId: "thread-1" }],
        verdict: "CHANGES_REQUESTED",
      }),
      approvedOutput(),
    ])
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    mockGitHub(magi, github)

    await expect(executeReview(magi, createContext())).resolves.toContain(
      "- **Verdict**: Approved",
    )

    const { events, state } = await readRun(config)

    expect(client.session.prompt).toHaveBeenCalledTimes(2)
    expect(github.resolveReviewThread).toHaveBeenCalledWith({
      threadId: "thread-1",
    })
    expect(github.createReplyForReviewComment).toHaveBeenCalledWith({
      body: "Can you clarify this?",
      comment_id: 7,
      owner: "magi-ai",
      pull_number: 123,
      repo: "opencode-magi",
    })
    expect(state.reviewers?.["reviewer-one"]?.outputs).toStrictEqual([
      {
        comment: "Following up on the existing thread.",
        followUps: [{ body: "Can you clarify this?", commentId: 7 }],
        resolves: [{ commentId: 7, threadId: "thread-1" }],
        verdict: "CHANGES_REQUESTED",
      },
    ])
    expect(state.reviewers?.["reviewer-two"]?.outputs).toStrictEqual([
      { verdict: "APPROVED" },
    ])
    expect(state.reviewers?.["reviewer-three"]?.outputs).toStrictEqual([
      { verdict: "APPROVED" },
    ])
    expect(events.map(({ message }) => message)).toStrictEqual(
      expect.arrayContaining([
        "Running rereview with reviewer reviewer-one.",
        "Skipping review with reviewer reviewer-two.",
        "Running review with reviewer reviewer-three.",
      ]),
    )
  })

  describe.each(["single", "multi"] as const)(
    "%s mode change requests",
    (mode) => {
      test("posts accepted findings", async ({
        createMagi,
        temporaryDirectory,
      }) => {
        const repository = await createRepository(temporaryDirectory)
        const config = createPullRequestConfig(temporaryDirectory, mode)
        const metadata = createPullRequestMetadata(
          temporaryDirectory,
          repository,
        )
        const github = createGitHubFixture(metadata, PULL_REQUEST)
        const { client, magi } = createMagi({ directory: temporaryDirectory })
        const ghCommands: string[] = []
        const finding = (body: string): object => ({
          body,
          line: 2,
          path: "reviewed.txt",
        })
        const vote = (reviewer: string): object => ({
          comment: "Confirmed.",
          index: 0,
          reviewer,
          vote: "AGREE",
        })
        const outputs = [
          JSON.stringify({
            comment: "Reviewer one found an issue.",
            findings: [finding("Finding one")],
            verdict: "CHANGES_REQUESTED",
          }),
          JSON.stringify({
            comment: "Reviewer two found an issue.",
            findings: [finding("Finding two")],
            verdict: "CHANGES_REQUESTED",
          }),
          approvedOutput(),
          JSON.stringify({ votes: [vote("reviewer-two")] }),
          JSON.stringify({ votes: [vote("reviewer-one")] }),
          JSON.stringify({
            votes: [vote("reviewer-one"), vote("reviewer-two")],
          }),
        ]

        if (mode === "single")
          outputs.push(
            JSON.stringify({ comment: "Please address the findings." }),
          )

        config.review.concurrency.reviewers = 1
        magi.exec = createReviewExec(repository, ghCommands)
        mockSessions(client)
        mockPromptOutputs(client, outputs)
        vi.spyOn(magi, "getConfig").mockResolvedValue(config)
        mockGitHub(magi, github)

        await expect(executeReview(magi, createContext())).resolves.toContain(
          "- **Verdict**: Changes Requested",
        )

        const { report, state } = await readRun(config)
        const posted = github.createReview.mock.calls.map(([input]) => input)

        expect(state.pr?.verdict).toBe("CHANGES_REQUESTED")
        expect(
          state.reviewers?.["reviewer-one"]?.outputs?.[0]?.findings?.[0]?.state,
        ).toBe("accepted")
        expect(
          state.reviewers?.["reviewer-two"]?.outputs?.[0]?.findings?.[0]?.state,
        ).toBe("accepted")
        expect(report).toContain("Finding one")
        expect(report).toContain("Finding two")
        expect(posted).toHaveLength(mode === "single" ? 1 : 3)
        expect(
          posted.filter(({ event }) => event === "REQUEST_CHANGES"),
        ).toHaveLength(mode === "single" ? 1 : 2)

        expect(posted[0]?.body).toContain(
          mode === "single"
            ? "Please address the findings."
            : "Reviewer one found an issue.",
        )
        expect(posted[0]?.comments).toHaveLength(mode === "single" ? 2 : 1)
      })
    },
  )

  test("promotes a reviewer to approved when its finding is rejected", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const repository = await createRepository(temporaryDirectory)
    const config = createPullRequestConfig(temporaryDirectory, "single")
    const metadata = createPullRequestMetadata(temporaryDirectory, repository)
    const github = createGitHubFixture(metadata, PULL_REQUEST)
    const { client, magi } = createMagi({ directory: temporaryDirectory })
    const ghCommands: string[] = []
    const disagreement = {
      comment: "Not reproducible.",
      index: 0,
      reviewer: "reviewer-one",
      vote: "DISAGREE",
    }

    config.review.concurrency.reviewers = 1
    magi.exec = createReviewExec(repository, ghCommands)
    mockSessions(client)
    mockPromptOutputs(client, [
      JSON.stringify({
        comment: "Potential issue.",
        findings: [{ body: "Rejected finding", line: 2, path: "reviewed.txt" }],
        verdict: "CHANGES_REQUESTED",
      }),
      approvedOutput(),
      approvedOutput(),
      JSON.stringify({ votes: [] }),
      JSON.stringify({ votes: [disagreement] }),
      JSON.stringify({ votes: [disagreement] }),
    ])
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    mockGitHub(magi, github)

    await expect(executeReview(magi, createContext())).resolves.toContain(
      "- **Verdict**: Approved",
    )

    const { events, report, state } = await readRun(config)

    expect(state.reviewers?.["reviewer-one"]?.outputs).toHaveLength(2)
    expect(
      state.reviewers?.["reviewer-one"]?.outputs?.[0]?.findings?.[0]?.state,
    ).toBe("discarded")
    expect(state.reviewers?.["reviewer-one"]?.outputs?.[1]?.verdict).toBe(
      "APPROVED",
    )
    expect(report).toContain("~~`reviewed.txt:2`: Rejected finding~~")
    expect(events.map(({ message }) => message)).toStrictEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Reviewer reviewer-one verdict changed from Changes Requested to Approved",
        ),
      ]),
    )
  })

  test("classifies and reruns an out-of-scope failed check before review", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const repository = await createRepository(temporaryDirectory)
    const config = createPullRequestConfig(temporaryDirectory, "single")
    const metadata = createPullRequestMetadata(temporaryDirectory, repository)
    const github = createGitHubFixture(metadata, PULL_REQUEST)
    const { client, magi } = createMagi({ directory: temporaryDirectory })
    const ghCommands: string[] = []

    let checks = 0

    const failedCheck = {
      bucket: "fail",
      link: "https://github.com/actions/runs/1/job/11",
      name: "test",
      state: "FAILURE",
      workflow: "CI",
    }
    const passedCheck = { ...failedCheck, bucket: "pass", state: "SUCCESS" }

    config.review.concurrency.reviewers = 1
    magi.exec = createReviewExec(repository, ghCommands, (command) => {
      if (command.includes("gh pr checks 123") && command.includes("--json")) {
        checks += 1

        return JSON.stringify(checks === 1 ? [failedCheck] : [passedCheck])
      }

      if (command.includes("gh run view") && command.includes("--log-failed"))
        return "\u001b[31mfailed log\u001b[0m"
      if (command.includes("gh run rerun")) return ""
      if (command.includes("gh pr checks 123") && command.includes("--watch"))
        return ""
    })
    mockSessions(client)
    mockPromptOutputs(client, [
      ...REVIEWERS.map(() =>
        JSON.stringify({
          checks: [
            {
              classification: "SCOPE_OUT",
              comment: "Unrelated infrastructure failure.",
              id: "11",
            },
          ],
        }),
      ),
      ...REVIEWERS.map(() => approvedOutput()),
    ])
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    mockGitHub(magi, github)

    await expect(executeReview(magi, createContext())).resolves.toContain(
      "- **Check**: Pass",
    )

    const { events, state } = await readRun(config)

    expect(state.pr?.checks?.failed).toStrictEqual([])
    expect(state.pr?.checks?.passed[0]).toMatchObject({
      id: "11",
      scope: false,
      state: "SUCCESS",
    })
    expect(ghCommands).toStrictEqual(
      expect.arrayContaining([
        "gh run view --repo 'magi-ai/opencode-magi' --job '11' --log-failed",
        "gh run rerun --repo 'magi-ai/opencode-magi' --job '11'",
        "gh pr checks 123 --repo 'magi-ai/opencode-magi' --watch --required",
      ]),
    )
    expect(events.map(({ message }) => message)).toContain(
      "Reran checks test passed.",
    )
  })

  test("reports in-scope, pending, and excluded checks without rerunning", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const repository = await createRepository(temporaryDirectory)
    const config = createPullRequestConfig(temporaryDirectory, "single")
    const metadata = createPullRequestMetadata(temporaryDirectory, repository)
    const github = createGitHubFixture(metadata, PULL_REQUEST)
    const { client, magi } = createMagi({ directory: temporaryDirectory })
    const ghCommands: string[] = []
    const check = (
      name: string,
      bucket: string,
      state: string,
      job: number,
    ): object => ({
      bucket,
      link: `https://github.com/actions/runs/1/job/${job}`,
      name,
      state,
      workflow: "CI",
    })

    config.review.checks.exclude = ["excluded"]
    config.review.concurrency.reviewers = 1
    magi.exec = createReviewExec(repository, ghCommands, (command) => {
      if (command.includes("gh pr checks 123") && command.includes("--json"))
        return JSON.stringify([
          check("failed", "fail", "FAILURE", 11),
          check("pending", "pending", "PENDING", 12),
          check("excluded", "fail", "FAILURE", 13),
          check("passed", "pass", "SUCCESS", 14),
        ])
      if (command.includes("gh run view") && command.includes("--job '11'"))
        return "failed log"
    })
    mockSessions(client)
    mockPromptOutputs(client, [
      ...REVIEWERS.map(() =>
        JSON.stringify({
          checks: [
            {
              classification: "SCOPE_IN",
              comment: "Introduced by this change.",
              id: "11",
            },
          ],
        }),
      ),
      ...REVIEWERS.map(() => approvedOutput()),
    ])
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    mockGitHub(magi, github)

    await expect(executeReview(magi, createContext())).resolves.toContain(
      "- **failed**: In-scope failure",
    )

    const { report, state } = await readRun(config)

    expect(state.pr?.checks).toMatchObject({
      excluded: [{ id: "13", name: "excluded" }],
      failed: [{ id: "11", name: "failed", scope: true }],
      passed: [{ id: "14", name: "passed" }],
      pending: [{ id: "12", name: "pending" }],
    })
    expect(report).toContain("- **pending**: Pending")
    expect(
      ghCommands.some((command) => command.includes("gh run rerun")),
    ).toBeFalsy()
  })

  test("repairs invalid reviewer output and preserves both attempts", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const repository = await createRepository(temporaryDirectory)
    const config = createPullRequestConfig(temporaryDirectory, "single")
    const metadata = createPullRequestMetadata(temporaryDirectory, repository)
    const github = createGitHubFixture(metadata, PULL_REQUEST)
    const { client, magi } = createMagi({ directory: temporaryDirectory })
    const ghCommands: string[] = []

    config.output.repairAttempts = 2
    config.review.concurrency.reviewers = 1
    magi.exec = createReviewExec(repository, ghCommands)
    mockSessions(client)
    mockPromptOutputs(client, [
      "not json",
      approvedOutput(),
      approvedOutput(),
      approvedOutput(),
    ])
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    mockGitHub(magi, github)

    await expect(executeReview(magi, createContext())).resolves.toContain(
      "- **Verdict**: Approved",
    )

    const { events, output } = await readRun(config)

    await expect(
      readFile(join(output, "reviewer-one-review-1-1.md"), "utf8"),
    ).resolves.toBe("not json")
    await expect(
      readFile(join(output, "reviewer-one-review-1-2.md"), "utf8"),
    ).resolves.toBe(approvedOutput())
    expect(events.map(({ message }) => message)).toContain(
      "Attempt 1 failed to review with reviewer reviewer-one. Retrying...",
    )
  })

  test("blocks the scenario when reviewer repair attempts are exhausted", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const repository = await createRepository(temporaryDirectory)
    const config = createPullRequestConfig(temporaryDirectory, "single")
    const metadata = createPullRequestMetadata(temporaryDirectory, repository)
    const github = createGitHubFixture(metadata, PULL_REQUEST)
    const { client, magi } = createMagi({ directory: temporaryDirectory })
    const ghCommands: string[] = []

    config.review.concurrency.reviewers = 1
    magi.exec = createReviewExec(repository, ghCommands)
    mockSessions(client)
    mockPromptOutputs(client, ["not json"])
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    mockGitHub(magi, github)

    await expect(executeReview(magi, createContext())).rejects.toThrow(
      "Invalid output for reviewer reviewer-one.",
    )

    const { report, state } = await readRun(config)

    expect(state.status).toBe("blocked")
    expect(report).toContain("- **Status**: Blocked")
    expect(report).toContain(
      "- **Error**: Invalid output for reviewer reviewer-one.",
    )
    expect(github.createReview).not.toHaveBeenCalled()
    await expect(access(state.worktree!.path)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  test("reconsiders a minority close verdict under unanimous approval", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const repository = await createRepository(temporaryDirectory)
    const config = createPullRequestConfig(temporaryDirectory, "single")
    const metadata = createPullRequestMetadata(temporaryDirectory, repository)
    const github = createGitHubFixture(metadata, PULL_REQUEST)
    const { client, magi } = createMagi({ directory: temporaryDirectory })
    const ghCommands: string[] = []

    config.review.concurrency.reviewers = 1
    config.review.merge.approvalPolicy = "unanimous"
    magi.exec = createReviewExec(repository, ghCommands)
    mockSessions(client)
    mockPromptOutputs(client, [
      JSON.stringify({ comment: "Initially close.", verdict: "CLOSED" }),
      approvedOutput(),
      approvedOutput(),
      approvedOutput(),
    ])
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    mockGitHub(magi, github)

    await expect(executeReview(magi, createContext())).resolves.toContain(
      "- **Verdict**: Approved",
    )

    const { events, output, state } = await readRun(config)

    expect(state.reviewers?.["reviewer-one"]?.outputs).toStrictEqual([
      { comment: "Initially close.", verdict: "CLOSED" },
      { verdict: "APPROVED" },
    ])
    expect(events.map(({ message }) => message)).toStrictEqual(
      expect.arrayContaining([
        "Reconsidering close verdicts.",
        "Finished reconsidering close verdicts.",
      ]),
    )
    await expect(
      readFile(
        join(output, "reviewer-one-close-reconsideration-2-1.md"),
        "utf8",
      ),
    ).resolves.toBe(approvedOutput())
  })

  test("posts closed reviews and closes the pull request", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const repository = await createRepository(temporaryDirectory)
    const config = createPullRequestConfig(temporaryDirectory, "single")
    const metadata = createPullRequestMetadata(temporaryDirectory, repository)
    const github = createGitHubFixture(metadata, PULL_REQUEST)
    const { client, magi } = createMagi({ directory: temporaryDirectory })
    const ghCommands: string[] = []

    config.review.automation.close = true
    config.review.concurrency.reviewers = 1
    magi.exec = createReviewExec(repository, ghCommands, (command) => {
      if (command.startsWith("gh auth token")) return "token"
      if (command.startsWith("gh pr close")) return ""
    })
    mockSessions(client)
    mockPromptOutputs(client, [
      ...REVIEWERS.map(() =>
        JSON.stringify({
          comment: "Close this pull request.",
          verdict: "CLOSED",
        }),
      ),
      JSON.stringify({ comment: "Closing because the change is unsuitable." }),
    ])
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    mockGitHub(magi, github)

    await expect(executeReview(magi, createContext())).resolves.toContain(
      "- **Automation**: Closed",
    )

    const { state } = await readRun(config)

    expect(state.pr?.verdict).toBe("CLOSED")
    expect(state.pr?.automation).toBe("CLOSED")
    expect(github.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: "COMMENT" }),
    )
    expect(ghCommands).toContain(
      "gh pr close 123 --repo 'magi-ai/opencode-magi'",
    )
  })

  test("merges an approved pull request with direct auto-merge", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const repository = await createRepository(temporaryDirectory)
    const config = createPullRequestConfig(temporaryDirectory, "single")
    const metadata = createPullRequestMetadata(temporaryDirectory, repository)
    const github = createGitHubFixture(metadata, PULL_REQUEST)
    const { client, magi } = createMagi({ directory: temporaryDirectory })
    const ghCommands: string[] = []

    config.review.automation.merge = true
    config.review.concurrency.reviewers = 1
    magi.exec = createReviewExec(repository, ghCommands, (command) => {
      if (command.startsWith("gh auth token")) return "token"
      if (command.startsWith("gh api ")) return "[]"
      if (command.startsWith("gh pr merge")) return ""
      if (command.startsWith("gh pr view"))
        return JSON.stringify({
          autoMergeRequest: {},
          mergeStateStatus: "CLEAN",
          state: "MERGED",
          statusCheckRollup: [],
        })
    })
    mockSessions(client)
    mockPromptOutputs(
      client,
      REVIEWERS.map(() => approvedOutput()),
    )
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    mockGitHub(magi, github)

    await expect(executeReview(magi, createContext())).resolves.toContain(
      "- **Automation**: Merged",
    )

    const { state } = await readRun(config)

    expect(state.pr?.automation).toBe("MERGED")
    expect(ghCommands).toContain(
      "gh pr merge 123 --repo 'magi-ai/opencode-magi' --squash --auto --delete-branch",
    )
    expect(ghCommands).toContain(
      "gh pr view 123 --repo 'magi-ai/opencode-magi' --json autoMergeRequest,mergeStateStatus,state,statusCheckRollup",
    )
  })

  test("marks an aborted in-progress scenario as cancelled and cleans its worktree", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const repository = await createRepository(temporaryDirectory)
    const config = createPullRequestConfig(temporaryDirectory, "single")
    const metadata = createPullRequestMetadata(temporaryDirectory, repository)
    const github = createGitHubFixture(metadata, PULL_REQUEST)
    const { client, magi } = createMagi({ directory: temporaryDirectory })
    const ghCommands: string[] = []
    const controller = new AbortController()

    config.review.concurrency.reviewers = 1
    magi.exec = createReviewExec(repository, ghCommands)
    mockSessions(client)
    client.session.prompt.mockImplementation(() => {
      controller.abort()

      return Promise.reject(new DOMException("Aborted", "AbortError"))
    })
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    mockGitHub(magi, github)

    await expect(
      executeReview(magi, createContext(controller)),
    ).rejects.toThrow(/aborted/i)

    const output = await getRunOutput(config)
    const state = JSON.parse(
      await readFile(join(output, "state.json"), "utf8"),
    ) as State

    expect(state.status).toBe("cancelled")
    await expect(access(state.worktree!.path)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
})
