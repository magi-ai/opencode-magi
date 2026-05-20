import type { ResolvedRepository } from "../types"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  composeCloseReconsiderationPrompt,
  composeCiClassificationAfterEditPrompt,
  composeCiClassificationPrompt,
  composeEditPrompt,
  composeFindingValidationPrompt,
  composeRereviewCloseReconsiderationPrompt,
  composeRereviewPrompt,
  composeReviewPrompt,
  composeTriageCommentPrompt,
  composeTriageCreatePrPrompt,
  composeTriageQuestionPrompt,
} from "./compose"

function evidence(
  overrides: Partial<{
    errorMessages: string[]
    failingFiles: string[]
    failingTests: string[]
    relevantFrames: string[]
    representativeLog: string
  }> = {},
) {
  return {
    errorMessages: [],
    failingFiles: [],
    failingTests: [],
    relevantFrames: [],
    representativeLog: "",
    ...overrides,
  }
}

describe("prompt composer", () => {
  test("replaces task template while keeping fixed output contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "magi-prompt-"))
    const promptPath = "custom-review.md"
    const guidelinesPath = "review-guide.md"
    const editGuidelinesPath = "edit-guide.md"

    await writeFile(
      join(dir, promptPath),
      "Custom review for #{pr} in {owner}/{repo}.",
    )
    await writeFile(
      join(dir, guidelinesPath),
      "Prefer approving improvements for {owner}/{repo}.",
    )
    await writeFile(
      join(dir, editGuidelinesPath),
      "Keep fixes scoped to PR #{pr} in {owner}/{repo}.",
    )

    const repository: ResolvedRepository = {
      agents: {
        reviewers: [
          {
            key: "reviewer-1",
            index: 0,
            model: "model",
            account: "bot",
            persona: "Focus on tests.",
            permission: { read: "allow" },
          },
        ],
        editor: {
          model: "model",
          account: "bot",
          author: { email: "bot@example.com", name: "Bot" },
          permission: { edit: "allow" },
        },
      },
      alias: "repo",
      automation: { close: true, merge: true },
      checks: {
        exclude: [],
        retryFailedJobs: 3,
        waitAfterEdit: true,
        waitBeforeReview: true,
      },
      concurrency: { runs: 3, reviewers: 3 },
      github: {
        apiRetryAttempts: 3,
        host: "github.com",
        owner: "owner",
        repo: "repo",
      },
      language: "ja",
      merge: {
        approvalPolicy: "majority",
        method: "squash",
        auto: true,
        deleteBranch: true,
        mergeQueue: true,
        maxThreadResolutionCycles: 5,
      },
      prompts: {
        editGuidelines: editGuidelinesPath,
        review: promptPath,
        reviewGuidelines: guidelinesPath,
      },
      safety: { allowAuthors: [], blockedPaths: [], requiredLabels: [] },
    }

    const prompt = await composeReviewPrompt({
      baseSha: "base",
      directory: dir,
      headSha: "head",
      pr: 1,
      repository,
      reviewContext:
        "<pull_request_context>\nnumber: 1\n</pull_request_context>",
      reviewer: repository.agents.reviewers[0],
      worktreePath: "/tmp/worktree",
    })

    expect(prompt).toContain(
      "<task>\nCustom review for #1 in owner/repo.\n</task>",
    )
    expect(prompt).toContain(
      "<pull_request_context>\nnumber: 1\n</pull_request_context>",
    )
    expect(prompt).not.toContain("Review pull request #1")
    expect(prompt.indexOf("Custom review for #1")).toBeLessThan(
      prompt.indexOf("<pull_request_context>"),
    )
    expect(prompt.indexOf("<pull_request_context>")).toBeLessThan(
      prompt.indexOf("<output_contract>"),
    )
    expect(prompt).toContain("<language>\nja\n</language>")
    expect(prompt).toContain(
      "<review_guidelines>\nPrefer approving improvements for owner/repo.\n</review_guidelines>",
    )
    expect(prompt.indexOf("<review_guidelines>")).toBeLessThan(
      prompt.indexOf("<output_contract>"),
    )
    expect(prompt).toContain(
      '"verdict": "MERGE" | "CHANGES_REQUESTED" | "CLOSE"',
    )

    const rereviewPrompt = await composeRereviewPrompt({
      baseSha: "base",
      directory: dir,
      headSha: "head",
      pr: 1,
      previousHeadSha: "old",
      previousReview: "Previously requested changes for tests.",
      repository,
      reviewContext: "<closing_issues>\n(none)\n</closing_issues>",
      reviewer: repository.agents.reviewers[0],
      unresolvedThreads: "[]",
      worktreePath: "/tmp/worktree",
    })

    expect(rereviewPrompt).toContain(
      "<closing_issues>\n(none)\n</closing_issues>",
    )
    expect(rereviewPrompt).toContain(
      "<previous_review>\nPreviously requested changes for tests.\n</previous_review>",
    )
    expect(rereviewPrompt).toContain(
      "<review_guidelines>\nPrefer approving improvements for owner/repo.\n</review_guidelines>",
    )
    expect(rereviewPrompt).toContain(
      '"verdict": "MERGE" | "CHANGES_REQUESTED" | "CLOSE"',
    )
    expect(rereviewPrompt).toContain(
      "If you do not agree, reply in the same thread with a followUp",
    )
    expect(rereviewPrompt).toContain(
      "Do not duplicate an existing unresolved thread as a newFinding",
    )

    const rereviewWithoutGuidelines = await composeRereviewPrompt({
      baseSha: "base",
      directory: dir,
      headSha: "head",
      includeReviewGuidelines: false,
      includeSessionContext: false,
      pr: 1,
      previousHeadSha: "old",
      repository,
      reviewer: repository.agents.reviewers[0],
      unresolvedThreads: "[]",
      worktreePath: "/tmp/worktree",
    })

    expect(rereviewWithoutGuidelines).not.toContain("<review_guidelines>")
    expect(rereviewWithoutGuidelines).not.toContain("<language>")
    expect(rereviewWithoutGuidelines).not.toContain("<persona>")

    const findingValidationPrompt = await composeFindingValidationPrompt({
      baseSha: "base",
      directory: dir,
      findings: "[]",
      headSha: "head",
      pr: 1,
      repository,
      reviewer: repository.agents.reviewers[0],
      worktreePath: "/tmp/worktree",
    })

    expect(findingValidationPrompt).not.toContain("<review_guidelines>")
    expect(findingValidationPrompt).not.toContain("<language>")
    expect(findingValidationPrompt).not.toContain("<persona>")
    expect(findingValidationPrompt).not.toContain("/tmp/worktree")
    expect(findingValidationPrompt).not.toContain("git -C")

    const firstSessionFindingValidationPrompt =
      await composeFindingValidationPrompt({
        baseSha: "base",
        directory: dir,
        findings: "[]",
        headSha: "head",
        includeReviewGuidelines: true,
        includeSessionContext: true,
        pr: 1,
        repository,
        reviewer: repository.agents.reviewers[0],
        worktreePath: "/tmp/worktree",
      })

    expect(firstSessionFindingValidationPrompt).toContain(
      "<review_guidelines>\nPrefer approving improvements for owner/repo.\n</review_guidelines>",
    )
    expect(firstSessionFindingValidationPrompt).toContain(
      "<language>\nja\n</language>",
    )
    expect(firstSessionFindingValidationPrompt).toContain(
      "<persona>\nFocus on tests.\n</persona>",
    )

    const closeReconsiderationPrompt = await composeCloseReconsiderationPrompt({
      baseSha: "base",
      closeReason: "Out of scope.",
      directory: dir,
      headSha: "head",
      pr: 1,
      repository,
      reviewer: repository.agents.reviewers[0],
      worktreePath: "/tmp/worktree",
    })

    expect(closeReconsiderationPrompt).not.toContain("<review_guidelines>")
    expect(closeReconsiderationPrompt).not.toContain("<language>")
    expect(closeReconsiderationPrompt).not.toContain("<persona>")
    expect(closeReconsiderationPrompt).not.toContain("/tmp/worktree")
    expect(closeReconsiderationPrompt).not.toContain("git -C")

    const firstSessionCloseReconsiderationPrompt =
      await composeCloseReconsiderationPrompt({
        baseSha: "base",
        closeReason: "Out of scope.",
        directory: dir,
        headSha: "head",
        includeReviewGuidelines: true,
        includeSessionContext: true,
        pr: 1,
        repository,
        reviewer: repository.agents.reviewers[0],
        worktreePath: "/tmp/worktree",
      })

    expect(firstSessionCloseReconsiderationPrompt).toContain(
      "<review_guidelines>\nPrefer approving improvements for owner/repo.\n</review_guidelines>",
    )

    const rereviewCloseReconsiderationPrompt =
      await composeRereviewCloseReconsiderationPrompt({
        baseSha: "base",
        closeReason: "Out of scope.",
        directory: dir,
        headSha: "head",
        pr: 1,
        previousHeadSha: "old",
        repository,
        reviewer: repository.agents.reviewers[0],
        worktreePath: "/tmp/worktree",
      })

    expect(rereviewCloseReconsiderationPrompt).not.toContain(
      "<review_guidelines>",
    )
    expect(rereviewCloseReconsiderationPrompt).not.toContain("<language>")
    expect(rereviewCloseReconsiderationPrompt).not.toContain("<persona>")
    expect(rereviewCloseReconsiderationPrompt).not.toContain("/tmp/worktree")
    expect(rereviewCloseReconsiderationPrompt).not.toContain("git -C")
    expect(rereviewCloseReconsiderationPrompt).not.toContain("[]")

    const firstSessionRereviewCloseReconsiderationPrompt =
      await composeRereviewCloseReconsiderationPrompt({
        baseSha: "base",
        closeReason: "Out of scope.",
        directory: dir,
        headSha: "head",
        includeReviewGuidelines: true,
        includeSessionContext: true,
        pr: 1,
        previousHeadSha: "old",
        repository,
        reviewer: repository.agents.reviewers[0],
        worktreePath: "/tmp/worktree",
      })

    expect(firstSessionRereviewCloseReconsiderationPrompt).toContain(
      "<review_guidelines>\nPrefer approving improvements for owner/repo.\n</review_guidelines>",
    )

    const editPrompt = await composeEditPrompt({
      directory: dir,
      pr: 1,
      repository,
      unresolvedThreads: "[]",
      worktreePath: "/tmp/worktree",
    })

    expect(editPrompt).toContain(
      "<edit_guidelines>\nKeep fixes scoped to PR #1 in owner/repo.\n</edit_guidelines>",
    )
    expect(editPrompt.indexOf("<edit_guidelines>")).toBeLessThan(
      editPrompt.indexOf("<output_contract>"),
    )
  })

  test("adds custom CI classification instructions before the contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "magi-prompt-"))
    const promptPath = "ci.md"

    await writeFile(
      join(dir, promptPath),
      "Treat Vercel deploy failures as SCOPE_OUT.\n{failedChecks}",
    )

    const repository: ResolvedRepository = {
      agents: { reviewers: [] },
      alias: "repo",
      automation: { close: true, merge: true },
      checks: {
        exclude: [],
        retryFailedJobs: 3,
        waitAfterEdit: true,
        waitBeforeReview: true,
      },
      concurrency: { runs: 3, reviewers: 3 },
      github: {
        apiRetryAttempts: 3,
        host: "github.com",
        owner: "owner",
        repo: "repo",
      },
      merge: {
        approvalPolicy: "majority",
        auto: true,
        deleteBranch: true,
        maxThreadResolutionCycles: 5,
        mergeQueue: false,
        method: "squash",
      },
      prompts: { ciClassification: promptPath },
      safety: { allowAuthors: [], blockedPaths: [], requiredLabels: [] },
    }

    const prompt = await composeCiClassificationPrompt({
      checks: [
        {
          evidence: evidence({ errorMessages: ["failed"] }),
          link: "https://example.com",
          name: "Deploy",
          state: "FAILURE",
          workflow: "",
        },
      ],
      directory: dir,
      pr: 1,
      repository,
    })

    expect(prompt).toContain("Treat Vercel deploy failures as SCOPE_OUT.")
    expect(prompt).toContain('"evidence"')
    expect(prompt).not.toContain('"log"')
    expect(prompt.indexOf("Treat Vercel")).toBeLessThan(
      prompt.indexOf("<output_contract>"),
    )
  })

  test("uses after-edit CI classification context", async () => {
    const dir = await mkdtemp(join(tmpdir(), "magi-prompt-"))
    const promptPath = "ci-after-edit.md"

    await writeFile(
      join(dir, promptPath),
      "After edit cycle {cycle}: inspect {previousHeadSha}...{headSha}.",
    )

    const repository: ResolvedRepository = {
      agents: { reviewers: [] },
      alias: "repo",
      automation: { close: true, merge: true },
      checks: {
        exclude: [],
        retryFailedJobs: 3,
        waitAfterEdit: true,
        waitBeforeReview: true,
      },
      concurrency: { runs: 3, reviewers: 3 },
      github: {
        apiRetryAttempts: 3,
        host: "github.com",
        owner: "owner",
        repo: "repo",
      },
      merge: {
        approvalPolicy: "majority",
        auto: true,
        deleteBranch: true,
        maxThreadResolutionCycles: 5,
        mergeQueue: false,
        method: "squash",
      },
      prompts: { ciClassificationAfterEdit: promptPath },
      safety: { allowAuthors: [], blockedPaths: [], requiredLabels: [] },
    }

    const prompt = await composeCiClassificationAfterEditPrompt({
      checks: [
        {
          evidence: evidence({ errorMessages: ["failed"] }),
          link: "https://example.com",
          name: "Test",
          state: "FAILURE",
          workflow: "CI",
        },
      ],
      cycle: 2,
      directory: dir,
      headSha: "new",
      previousHeadSha: "old",
      pr: 1,
      repository,
      worktreePath: "/tmp/worktree",
    })

    expect(prompt).toContain("After edit cycle 2: inspect old...new.")
    expect(prompt).toContain("caused by the PR changes or the editor changes")
  })

  test("uses configured triage comment, question, and create PR prompts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "magi-prompt-"))
    await writeFile(
      join(dir, "triage-comment.md"),
      "Comment for @{author}: {context}",
    )
    await writeFile(
      join(dir, "triage-question.md"),
      "Question for @{author}: {context}",
    )
    await writeFile(
      join(dir, "triage-create.md"),
      "Implement in {worktreePath}: {context}",
    )

    const repository: ResolvedRepository = {
      agents: {
        reviewers: [],
        triageCreator: {
          account: "creator",
          author: { email: "bot@example.com", name: "Bot" },
          model: "openai/gpt",
          permission: { edit: "allow" },
          persona: "Keep the PR minimal.",
        },
      },
      alias: "repo",
      automation: { close: true, merge: true },
      checks: {
        exclude: [],
        retryFailedJobs: 3,
        waitAfterEdit: true,
        waitBeforeReview: true,
      },
      concurrency: { runs: 3, reviewers: 3 },
      github: {
        apiRetryAttempts: 3,
        host: "github.com",
        owner: "owner",
        repo: "repo",
      },
      merge: {
        approvalPolicy: "majority",
        auto: true,
        deleteBranch: true,
        maxThreadResolutionCycles: 5,
        mergeQueue: false,
        method: "squash",
      },
      prompts: {},
      safety: { allowAuthors: [], blockedPaths: [], requiredLabels: [] },
      triage: {
        account: "magi-bot",
        automation: {
          clear: ["triage"],
          close: false,
          create: true,
          merge: false,
          review: false,
        },
        categories: [
          {
            description: "Something is broken.",
            id: "bug",
            labels: ["bug"],
            types: ["Bug"],
          },
        ],
        concurrency: { runs: 3 },
        prompts: {
          comment: "triage-comment.md",
          create: "triage-create.md",
          question: "triage-question.md",
        },
        safety: {
          allowAuthors: [],
          allowMentionActors: [],
          allowMentionRoles: ["MEMBER"],
          blockedLabels: [],
          requiredLabels: ["triage"],
        },
      },
    }

    const commentPrompt = await composeTriageCommentPrompt({
      author: "octocat",
      context: "accepted",
      directory: dir,
      issue: 58,
      repository,
    })
    const questionPrompt = await composeTriageQuestionPrompt({
      author: "octocat",
      context: "missing logs",
      directory: dir,
      issue: 58,
      repository,
    })
    const createPrPrompt = await composeTriageCreatePrPrompt({
      context: "fix issue",
      directory: dir,
      issue: 58,
      repository,
      worktreePath: "/tmp/issue-58",
    })

    expect(commentPrompt).toContain("Comment for @octocat: accepted")
    expect(questionPrompt).toContain("Question for @octocat: missing logs")
    expect(createPrPrompt).toContain("Implement in /tmp/issue-58: fix issue")
    expect(createPrPrompt).toContain(
      "<persona>\nKeep the PR minimal.\n</persona>",
    )
    expect(createPrPrompt).toContain('"mode": "EDITED" | "REPLIED"')
    expect(createPrPrompt).toContain('"pullRequest"')
    expect(createPrPrompt).toContain(
      "The orchestrator pushes and creates the PR using pullRequest exactly as provided.",
    )
  })
})
