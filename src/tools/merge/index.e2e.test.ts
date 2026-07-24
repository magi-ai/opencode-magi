import type { ToolContext } from "@opencode-ai/plugin"
import type { ClientMocks, CreateMagi } from "#/fixtures/magi"
import type { Config } from "@/config"
import type { Event, Magi, State } from "@/magi"
import type { Exec } from "@/utils"
import { access, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { Readable } from "node:stream"
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
    .mockResolvedValueOnce({ data: { id: "editor-session" } })
}

function mockPromptOutputs(client: ClientMocks, outputs: string[]): void {
  // Each prompt needs a fresh stream to avoid accumulating event listeners.
  // oxlint-disable-next-line vitest/prefer-mock-promise-shorthand
  client.event.subscribe.mockImplementation(() =>
    Promise.resolve({ stream: Readable.from([]) }),
  )
  client.session.prompt.mockImplementation(() => {
    const text = outputs.shift()

    if (text == null) return Promise.reject(new Error("Prompt output missing."))

    return Promise.resolve({ data: { parts: [{ text, type: "text" }] } })
  })
}

function mockGitHub(
  magi: Magi,
  github: ReturnType<typeof createGitHubFixture>,
): void {
  vi.spyOn(magi, "createOctokit").mockResolvedValue(github.octokit)
  vi.spyOn(magi, "createGraphql").mockReturnValue(github.graphql)
}

function createContext(controller = new AbortController()): ToolContext {
  return {
    abort: controller.signal,
    sessionID: "parent-session",
  } as ToolContext
}

async function executeMerge(
  magi: Magi,
  context: ToolContext,
  prs = PULL_REQUEST.number.toString(),
): Promise<string> {
  const mergeTool = merge(magi).magi_merge

  if (!mergeTool) throw new Error("Merge tool not found.")

  const result = await mergeTool.execute({ prs }, context)

  if (typeof result !== "string")
    throw new Error("Merge tool did not return a report.")

  return result
}

async function getRunOutput(config: Config.Root): Promise<string> {
  const numberOutput = join(
    config.review.output,
    PULL_REQUEST.number.toString(),
  )
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

function approvedOutput(): string {
  return JSON.stringify({ verdict: "APPROVED" })
}

function changeOutput(body: string): string {
  return JSON.stringify({
    comment: `${body} comment`,
    findings: [{ body, line: 2, path: "reviewed.txt" }],
    verdict: "CHANGES_REQUESTED",
  })
}

function vote(reviewer: string): object {
  return {
    comment: "Confirmed.",
    index: 0,
    reviewer,
    vote: "AGREE",
  }
}

function initialChangeOutputs(): string[] {
  return [
    changeOutput("Finding one"),
    changeOutput("Finding two"),
    approvedOutput(),
    JSON.stringify({ votes: [vote("reviewer-two")] }),
    JSON.stringify({ votes: [vote("reviewer-one")] }),
    JSON.stringify({
      votes: [vote("reviewer-one"), vote("reviewer-two")],
    }),
    JSON.stringify({ comment: "Please address the findings." }),
  ]
}

function remainingFindingValidationOutputs(): string[] {
  return [
    JSON.stringify({ votes: [vote("reviewer-two")] }),
    JSON.stringify({ votes: [] }),
    JSON.stringify({ votes: [vote("reviewer-two")] }),
  ]
}

function allFindingValidationOutputs(): string[] {
  return [
    JSON.stringify({ votes: [vote("reviewer-two")] }),
    JSON.stringify({ votes: [vote("reviewer-one")] }),
    JSON.stringify({
      votes: [vote("reviewer-one"), vote("reviewer-two")],
    }),
  ]
}

type GraphqlPage = "issues" | "thread" | "threads"

function configureGraphqlPages(
  github: ReturnType<typeof createGitHubFixture>,
  pages: GraphqlPage[],
): void {
  const thread = {
    comments: {
      nodes: [
        {
          author: { login: "review-bot" },
          body: [
            "Finding one",
            marker.stringify({
              command: "review",
              reviewer: "reviewer-one",
              verdict: "CHANGES_REQUESTED",
            }),
          ].join("\n\n"),
          createdAt: "2026-07-24T00:00:00.000Z",
          databaseId: 7,
        },
      ],
    },
    id: "thread-1",
    isResolved: false,
    line: 2,
    path: "reviewed.txt",
  }

  github.graphqlPaginate.mockImplementation(() => {
    const page = pages.shift()

    if (page === "issues")
      return Promise.resolve({
        repository: {
          pullRequest: { closingIssuesReferences: { nodes: [] } },
        },
      })

    return Promise.resolve({
      repository: {
        pullRequest: {
          reviewThreads: { nodes: page === "thread" ? [thread] : [] },
        },
      },
    })
  })
}

function createScenarioExec(
  repository: Awaited<ReturnType<typeof createRepository>>,
  ghCommands: string[],
  handler?: (
    command: string,
    options: Parameters<Exec>[1],
  ) => Promise<string | undefined> | string | undefined,
): Exec {
  return async function (command, options): Promise<string> {
    if (command.startsWith("gh ")) ghCommands.push(command)

    const output = await handler?.(command, options)

    if (output !== undefined) return output
    if (!command.startsWith("gh ")) return repository.exec(command, options)

    if (command === `gh pr checkout ${PULL_REQUEST.number} --detach`)
      return repository.exec(
        `git checkout --detach '${repository.headSha}'`,
        options,
      )
    if (
      command ===
      "gh pr checks 123 --repo 'magi-ai/opencode-magi' --json name,state,bucket,link,workflow --required"
    )
      return "[]"

    throw new Error(`Unexpected GitHub CLI command: ${command}`)
  }
}

interface PreparedReplyScenario {
  client: ClientMocks
  config: Config.Root
  ghCommands: string[]
  github: ReturnType<typeof createGitHubFixture>
  magi: Magi
}

async function prepareReplyScenario(
  createMagi: CreateMagi,
  temporaryDirectory: string,
  editorOutputs: string[],
  finalOutputs: string[],
  repairAttempts = 1,
): Promise<PreparedReplyScenario> {
  const repository = await createRepository(temporaryDirectory)
  const config = createPullRequestConfig(temporaryDirectory, "single")
  const metadata = createPullRequestMetadata(temporaryDirectory, repository)
  const github = createGitHubFixture(metadata, PULL_REQUEST)
  const { client, magi } = createMagi({ directory: temporaryDirectory })
  const ghCommands: string[] = []

  config.merge.maxThreadResolutionCycles = 1
  config.output.repairAttempts = repairAttempts
  config.review.concurrency.reviewers = 1
  configureGraphqlPages(github, [
    "threads",
    "issues",
    "threads",
    "thread",
    "issues",
    "thread",
  ])
  magi.exec = createScenarioExec(repository, ghCommands)
  mockSessions(client)
  mockPromptOutputs(client, [
    ...initialChangeOutputs(),
    ...editorOutputs,
    ...finalOutputs,
  ])
  vi.spyOn(magi, "getConfig").mockResolvedValue(config)
  mockGitHub(magi, github)

  return { client, config, ghCommands, github, magi }
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

  test("completes an editor reply cycle and rereviews the owning reviewer", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const editorOutput = JSON.stringify({
      mode: "REPLIED",
      responses: [
        {
          action: "DISAGREE",
          body: "No code change is needed.",
          commentId: 7,
        },
      ],
    })
    const { client, config, github, magi } = await prepareReplyScenario(
      createMagi,
      temporaryDirectory,
      [editorOutput],
      [approvedOutput(), ...remainingFindingValidationOutputs()],
    )

    await expect(executeMerge(magi, createContext())).resolves.toContain(
      "- **Cycle 1**: Replied",
    )

    const { events, report, state } = await readRun(config)

    expect(state.status).toBe("completed")
    expect(state.pr?.verdict).toBe("APPROVED")
    expect(state.editor?.outputs).toStrictEqual([
      {
        filesTouched: [],
        mode: "REPLIED",
        responses: [
          {
            action: "DISAGREE",
            body: "No code change is needed.",
            commentId: 7,
          },
        ],
      },
    ])
    expect(state.reviewers?.["reviewer-one"]?.outputs).toHaveLength(2)
    expect(state.reviewers?.["reviewer-two"]?.outputs).toHaveLength(1)
    expect(client.session.prompt).toHaveBeenCalledTimes(12)
    expect(github.createReplyForReviewComment).toHaveBeenCalledWith({
      body: "No code change is needed.",
      comment_id: 7,
      owner: "magi-ai",
      pull_number: 123,
      repo: "opencode-magi",
    })
    expect(report).toContain("No code change is needed.")
    expect(events.map(({ message }) => message)).toStrictEqual(
      expect.arrayContaining([
        "Creating editor session.",
        "Editing.",
        "Posting editor replies.",
        "Marking replied reviewers.",
        "Running rereview with reviewer reviewer-one.",
      ]),
    )
  })

  test("repairs invalid editor output within the full edit cycle", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const editorOutput = JSON.stringify({
      mode: "REPLIED",
      responses: [
        {
          action: "ASK",
          body: "Please clarify the expected behavior.",
          commentId: 7,
        },
      ],
    })
    const { config, magi } = await prepareReplyScenario(
      createMagi,
      temporaryDirectory,
      ["not json", editorOutput],
      [approvedOutput(), ...remainingFindingValidationOutputs()],
      2,
    )

    await expect(executeMerge(magi, createContext())).resolves.toContain(
      "- **Status**: Completed",
    )

    const { events, output } = await readRun(config)

    await expect(
      readFile(join(output, "editor-edit-1-1.md"), "utf8"),
    ).resolves.toBe("not json")
    await expect(
      readFile(join(output, "editor-edit-1-2.md"), "utf8"),
    ).resolves.toBe(editorOutput)
    expect(events.map(({ message }) => message)).toContain(
      "Attempt 1 failed to edit. Retrying...",
    )
  })

  test("blocks and cleans up when editor repair attempts are exhausted", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const { config, github, magi } = await prepareReplyScenario(
      createMagi,
      temporaryDirectory,
      ["not json"],
      [],
    )

    await expect(executeMerge(magi, createContext())).rejects.toThrow(
      "Invalid output for editor.",
    )

    const { report, state } = await readRun(config)

    expect(state.status).toBe("blocked")
    expect(report).toContain("- **Error**: Invalid output for editor.")
    expect(github.createReplyForReviewComment).not.toHaveBeenCalled()
    await expect(access(state.worktree!.path)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  test("fails the scenario when posting an editor reply fails", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const { config, github, magi } = await prepareReplyScenario(
      createMagi,
      temporaryDirectory,
      [
        JSON.stringify({
          mode: "REPLIED",
          responses: [
            {
              action: "ASK",
              body: "Need clarification.",
              commentId: 7,
            },
          ],
        }),
      ],
      [],
    )

    github.createReplyForReviewComment.mockRejectedValue(
      new Error("reply failed"),
    )

    await expect(executeMerge(magi, createContext())).rejects.toThrow(
      "reply failed",
    )

    const { report, state } = await readRun(config)

    expect(state.status).toBe("failed")
    expect(report).toContain("- **Error**: reply failed")
    await expect(access(state.worktree!.path)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  test("blocks after a complete edit cycle still requests changes", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const { config, github, magi } = await prepareReplyScenario(
      createMagi,
      temporaryDirectory,
      [
        JSON.stringify({
          mode: "REPLIED",
          responses: [
            {
              action: "DISAGREE",
              body: "The implementation is already correct.",
              commentId: 7,
            },
          ],
        }),
      ],
      [
        JSON.stringify({
          comment: "The concern remains.",
          followUps: [{ body: "Please reconsider.", commentId: 7 }],
          newFindings: [
            { body: "A new concern remains.", line: 2, path: "reviewed.txt" },
          ],
          verdict: "CHANGES_REQUESTED",
        }),
        ...allFindingValidationOutputs(),
        JSON.stringify({ comment: "Changes are still required." }),
      ],
    )

    await expect(executeMerge(magi, createContext())).rejects.toThrow(
      "Reached maximum edit cycles.",
    )

    const { report, state } = await readRun(config)

    expect(state.status).toBe("blocked")
    expect(state.pr?.verdict).toBe("CHANGES_REQUESTED")
    expect(report).toContain("- **Error**: Reached maximum edit cycles.")
    expect(github.createReplyForReviewComment).toHaveBeenCalledTimes(2)
    await expect(access(state.worktree!.path)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  test("pushes an editor commit, rechecks CI, and rereviews all reviewers", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const repository = await createRepository(temporaryDirectory)
    const config = createPullRequestConfig(temporaryDirectory, "single")
    const github = createGitHubFixture(
      createPullRequestMetadata(temporaryDirectory, repository),
      PULL_REQUEST,
    )
    const { client, magi } = createMagi({ directory: temporaryDirectory })
    const ghCommands: string[] = []
    const pushed: string[] = []
    const editorOutput = JSON.stringify({
      commitMessage: "fix review findings",
      commitSha: "edited-sha",
      filesTouched: ["reviewed.txt"],
      mode: "EDITED",
      responses: [
        {
          action: "FIXED",
          body: "Fixed in the latest commit.",
          commentId: 7,
        },
      ],
    })

    config.merge.maxThreadResolutionCycles = 1
    config.review.concurrency.reviewers = 1
    configureGraphqlPages(github, [
      "threads",
      "issues",
      "threads",
      "thread",
      "threads",
      "issues",
      "thread",
    ])
    magi.exec = createScenarioExec(
      repository,
      ghCommands,
      (command, options) => {
        if (command === "git rev-parse HEAD" && options?.cwd)
          return "edited-sha"

        if (command.startsWith("git push ")) {
          pushed.push(command)

          return ""
        }

        if (command.startsWith("gh auth token")) return "token"
      },
    )
    mockSessions(client)
    mockPromptOutputs(client, [
      ...initialChangeOutputs(),
      editorOutput,
      ...REVIEWERS.map(() => approvedOutput()),
    ])
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    mockGitHub(magi, github)

    await expect(executeMerge(magi, createContext())).resolves.toContain(
      "- **Cycle 1**: Edited",
    )

    const { events, state } = await readRun(config)

    expect(state.status).toBe("completed")
    expect(state.editor?.outputs?.[0]).toMatchObject({
      commitSha: "edited-sha",
      filesTouched: ["reviewed.txt"],
      mode: "EDITED",
    })
    expect(state.reviewers?.["reviewer-one"]?.outputs).toHaveLength(2)
    expect(state.reviewers?.["reviewer-two"]?.outputs).toHaveLength(2)
    expect(state.reviewers?.["reviewer-three"]?.outputs).toHaveLength(2)
    expect(pushed).toStrictEqual([
      "git push 'https://github.com/author/opencode-magi.git' 'HEAD:refs/heads/feature'",
    ])
    expect(
      events.filter(({ message }) => message === "Checking CI."),
    ).toHaveLength(2)
    expect(events.map(({ message }) => message)).toStrictEqual(
      expect.arrayContaining([
        "Pushing editor changes.",
        "Finished pushing editor changes.",
      ]),
    )
  })

  test("uses synthetic threads for an edited dry-run cycle without pushing", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const repository = await createRepository(temporaryDirectory)
    const config = createPullRequestConfig(temporaryDirectory, "single")
    const github = createGitHubFixture(
      createPullRequestMetadata(temporaryDirectory, repository),
      PULL_REQUEST,
    )
    const { client, magi } = createMagi({ directory: temporaryDirectory })
    const ghCommands: string[] = []
    const commands: string[] = []

    config.merge.maxThreadResolutionCycles = 1
    config.review.concurrency.reviewers = 1
    configureGraphqlPages(github, [
      "threads",
      "issues",
      "threads",
      "threads",
      "issues",
      "threads",
    ])
    magi.exec = createScenarioExec(repository, ghCommands, (command) => {
      commands.push(command)
    })
    mockSessions(client)
    mockPromptOutputs(client, [
      ...initialChangeOutputs().slice(0, -1),
      JSON.stringify({
        commitMessage: "dry-run fix",
        commitSha: repository.headSha,
        filesTouched: ["reviewed.txt"],
        mode: "EDITED",
        responses: [
          {
            action: "FIXED",
            body: "Would fix this finding.",
            commentId: -1,
          },
        ],
      }),
      approvedOutput(),
      ...remainingFindingValidationOutputs(),
    ])
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    mockGitHub(magi, github)

    await expect(
      executeMerge(magi, createContext(), "123 --dry-run"),
    ).resolves.toContain("- **Dry run**: Yes")

    const { events, state } = await readRun(config)

    expect(state.status).toBe("completed")
    expect(state.pr?.files).toStrictEqual(["reviewed.txt"])
    expect(state.editor?.outputs?.[0]).toMatchObject({
      commitSha: repository.headSha,
      mode: "EDITED",
    })
    expect(
      commands.some((command) => command.startsWith("git push ")),
    ).toBeFalsy()
    expect(github.createReplyForReviewComment).not.toHaveBeenCalled()
    expect(events.map(({ message }) => message)).toContain(
      "Skipped pushing editor changes during dry run.",
    )
  })

  test("applies merge command options during a complete dry run", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const repository = await createRepository(temporaryDirectory)
    const config = createPullRequestConfig(temporaryDirectory, "single")
    const github = createGitHubFixture(
      createPullRequestMetadata(temporaryDirectory, repository),
      PULL_REQUEST,
    )
    const { client, magi } = createMagi({ directory: temporaryDirectory })
    const ghCommands: string[] = []

    magi.exec = createScenarioExec(repository, ghCommands)
    mockSessions(client)
    mockPromptOutputs(
      client,
      REVIEWERS.map(() => approvedOutput()),
    )
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    mockGitHub(magi, github)

    await expect(
      executeMerge(
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
          "--max-cycles 4",
          "--retry-failed-jobs 3",
          "--concurrency-reviewers 1",
          "--concurrency-runs 2",
          "--wait-checks",
          "--no-wait-checks",
          "--wait-checks-after-edit",
          "--no-wait-checks-after-edit",
        ].join(" "),
      ),
    ).resolves.toContain("- **Dry run**: Yes")

    const { state } = await readRun(config)

    expect(config.github.retryApiAttempts).toBe(5)
    expect(config.language).toBe("ja")
    expect(config.merge.automation).toStrictEqual({
      close: false,
      conflict: false,
      merge: false,
    })
    expect(config.merge.checks.wait).toBeFalsy()
    expect(config.merge.maxThreadResolutionCycles).toBe(4)
    expect(config.review.checks.retryFailedJobs).toBe(3)
    expect(config.review.checks.wait).toBeFalsy()
    expect(config.review.concurrency).toStrictEqual({ reviewers: 1, runs: 2 })
    expect(state.dryRun).toBeTruthy()
    expect(github.createReview).not.toHaveBeenCalled()
  })

  test("merges an approved run after the review pipeline", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const repository = await createRepository(temporaryDirectory)
    const config = createPullRequestConfig(temporaryDirectory, "single")
    const github = createGitHubFixture(
      createPullRequestMetadata(temporaryDirectory, repository),
      PULL_REQUEST,
    )
    const { client, magi } = createMagi({ directory: temporaryDirectory })
    const ghCommands: string[] = []

    config.merge.automation.merge = true
    config.review.concurrency.reviewers = 1
    magi.exec = createScenarioExec(repository, ghCommands, (command) => {
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

    await expect(executeMerge(magi, createContext())).resolves.toContain(
      "- **Automation**: Merged",
    )

    const { state } = await readRun(config)

    expect(state.pr?.automation).toBe("MERGED")
    expect(ghCommands).toContain(
      "gh pr merge 123 --repo 'magi-ai/opencode-magi' --squash --auto --delete-branch",
    )
  })

  test("enqueues and merges an approved run through the merge queue", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const repository = await createRepository(temporaryDirectory)
    const config = createPullRequestConfig(temporaryDirectory, "single")
    const github = createGitHubFixture(
      createPullRequestMetadata(temporaryDirectory, repository),
      PULL_REQUEST,
    )
    const { client, magi } = createMagi({ directory: temporaryDirectory })
    const ghCommands: string[] = []
    const enqueuePullRequest = vi.fn().mockResolvedValue({})
    const mergeQueueStatus = vi.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          isInMergeQueue: false,
          mergeQueueEntry: null,
          state: "MERGED",
          timelineItems: { nodes: [] },
        },
      },
    })

    Object.assign(github.graphql, { enqueuePullRequest, mergeQueueStatus })
    config.merge.automation.merge = true
    config.review.concurrency.reviewers = 1
    config.review.merge.queue = true
    magi.exec = createScenarioExec(repository, ghCommands, (command) => {
      if (command.startsWith("gh auth token")) return "token"
    })
    mockSessions(client)
    mockPromptOutputs(
      client,
      REVIEWERS.map(() => approvedOutput()),
    )
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    mockGitHub(magi, github)

    await expect(executeMerge(magi, createContext())).resolves.toContain(
      "- **Automation**: Merged",
    )

    const { state } = await readRun(config)

    expect(state.pr?.automation).toBe("MERGED")
    expect(enqueuePullRequest).toHaveBeenCalledWith({
      id: "pull-request-node",
    })
    expect(mergeQueueStatus).toHaveBeenCalledWith({
      owner: "magi-ai",
      pr: 123,
      repo: "opencode-magi",
    })
    expect(
      ghCommands.some((command) => command.startsWith("gh pr merge")),
    ).toBeFalsy()
  })

  test("resolves an automation conflict, rereviews, and merges", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const repository = await createRepository(temporaryDirectory)
    const config = createPullRequestConfig(temporaryDirectory, "single")
    const github = createGitHubFixture(
      createPullRequestMetadata(temporaryDirectory, repository),
      PULL_REQUEST,
    )
    const { client, magi } = createMagi({ directory: temporaryDirectory })
    const ghCommands: string[] = []

    let diffChecks = 0
    let mergeAttempts = 0

    config.merge.automation.conflict = true
    config.merge.automation.merge = true
    config.merge.maxThreadResolutionCycles = 1
    config.review.concurrency.reviewers = 1
    configureGraphqlPages(github, [
      "threads",
      "issues",
      "threads",
      "threads",
      "issues",
      "threads",
    ])
    magi.exec = createScenarioExec(repository, ghCommands, (command) => {
      if (command === "git status --porcelain") return ""

      if (command === "git merge --no-commit --no-ff FETCH_HEAD") {
        mergeAttempts += 1

        if (mergeAttempts <= 2)
          return Promise.reject(new Error("merge conflict"))

        return ""
      }

      if (command === "git diff --name-only --diff-filter=U") {
        diffChecks += 1

        return diffChecks <= 2 ? "reviewed.txt" : ""
      }

      if (command === "git merge --abort") return ""
      if (command === "git rev-parse HEAD") return "resolved-sha"
      if (command === "git rev-list --parents -n 1 HEAD")
        return "resolved-sha parent-one parent-two"
      if (command === "git log -1 --pretty=%s") return "resolve conflicts"
      if (command.startsWith("git push ")) return ""
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
    mockPromptOutputs(client, [
      ...REVIEWERS.map(() => approvedOutput()),
      JSON.stringify({}),
      ...REVIEWERS.map(() => approvedOutput()),
    ])
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    mockGitHub(magi, github)

    await expect(executeMerge(magi, createContext())).resolves.toContain(
      "- **Automation**: Merged",
    )

    const { events, state } = await readRun(config)

    expect(state.pr?.automation).toBe("MERGED")
    expect(state.editor?.outputs?.[0]).toMatchObject({
      commitMessage: "resolve conflicts",
      commitSha: "resolved-sha",
      filesTouched: ["reviewed.txt"],
      mode: "RESOLVED",
    })
    expect(events.map(({ message }) => message)).toStrictEqual(
      expect.arrayContaining([
        "Merge automation found conflicts.",
        "Resolving merge conflicts.",
        "Finished resolving merge conflicts.",
        "Pushing conflict resolution.",
        "Finished pushing conflict resolution.",
      ]),
    )
    expect(ghCommands).toContain(
      "gh pr merge 123 --repo 'magi-ai/opencode-magi' --squash --auto --delete-branch",
    )
  })

  test("cancels an aborted edit scenario and removes its worktree", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const repository = await createRepository(temporaryDirectory)
    const config = createPullRequestConfig(temporaryDirectory, "single")
    const github = createGitHubFixture(
      createPullRequestMetadata(temporaryDirectory, repository),
      PULL_REQUEST,
    )
    const { client, magi } = createMagi({ directory: temporaryDirectory })
    const ghCommands: string[] = []
    const controller = new AbortController()

    config.review.concurrency.reviewers = 1
    magi.exec = createScenarioExec(repository, ghCommands)
    mockSessions(client)
    client.session.prompt.mockImplementation(() => {
      controller.abort()

      return Promise.reject(new DOMException("Aborted", "AbortError"))
    })
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    mockGitHub(magi, github)

    await expect(executeMerge(magi, createContext(controller))).rejects.toThrow(
      /aborted/i,
    )

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
