import type {
  DuplicateIssueCandidate,
  IssueComment,
  IssueMeta,
  RelatedPullRequest,
} from "../github/commands"
import type {
  EditOutput,
  Exec,
  MagiConfig,
  ResolvedRepository,
  ResolvedTriageAgent,
  TriageBinaryVote,
  TriageDuplicateOutput,
  TriageDuplicateVote,
  TriageExistingPrVote,
  TriageKindVote,
  TriageVoteOutput,
} from "../types"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { issueRunOutputDir } from "../config/output"
import { worktreeBaseDir } from "../config/worktree"
import {
  closeIssue,
  closePullRequest,
  configureGitIdentity,
  createPullRequest,
  fetchIssue,
  fetchIssueComments,
  fetchRelatedPullRequests,
  postIssueComment,
  pushHead,
  removeIssueLabels,
  removeWorktree,
  searchDuplicateIssues,
  shellQuote,
} from "../github/commands"
import {
  composeTriageBugPrompt,
  composeTriageCommentPrompt,
  composeTriageDuplicatePrompt,
  composeTriageExistingPrPrompt,
  composeTriageFeaturePrompt,
  composeTriageKindPrompt,
} from "../prompts/compose"
import {
  parseEditOutput,
  parseTriageBinaryOutput,
  parseTriageDuplicateOutput,
  parseTriageExistingPrOutput,
  parseTriageKindOutput,
} from "../prompts/output"
import { aggregateStringMajority } from "./majority"
import { runModelText, runModelWithRepair, type ModelClient } from "./model"

type FinalResult =
  | "ASK"
  | "BUG_ACCEPTED"
  | "BUG_REJECTED"
  | "CLEAR_ONLY"
  | "DUPLICATE"
  | "FEATURE_ACCEPTED"
  | "FEATURE_REJECTED"
  | "FAILED"

export interface TriageRunInput {
  client: ModelClient
  config: MagiConfig
  directory: string
  dryRun?: boolean
  exec: Exec
  issue: number
  repository: ResolvedRepository
  runId?: string
  signal?: AbortSignal
}

export interface TriageRunResult {
  issue: number
  outputDir: string
  report: string
  result: FinalResult
}

interface TriageMarker {
  action?: string
  checkpoint?: number
  issue?: number
  pr?: string
  processed: number[]
  result?: string
  v: number
}

interface RelationshipSummary {
  comments: IssueComment[]
  duplicateCandidates: DuplicateIssueCandidate[]
  previousMarker?: TriageMarker
  relatedPullRequests: RelatedPullRequest[]
}

type TriagePromptComposer = (input: {
  context: string
  directory: string
  issue: number
  repository: ResolvedRepository
  reviewer: ResolvedTriageAgent
}) => Promise<string>

const MARKER_PREFIX = "opencode-magi:triage"
const KIND_VOTES = ["ASK", "BUG", "FEATURE"] as const
const BINARY_VOTES = ["ASK", "NO", "YES"] as const
const DUPLICATE_VOTES = ["DUPLICATE", "NOT_DUPLICATE"] as const
const EXISTING_PR_VOTES = [
  "RELATED_PR_DOES_NOT_HANDLE_ISSUE",
  "RELATED_PR_HANDLES_ISSUE",
] as const

function marker(input: {
  action: string
  issue: number
  pr?: number
  processed?: number[]
  result: string
}): string {
  return `<!-- ${MARKER_PREFIX} v=1 issue=${input.issue} result=${input.result} action=${input.action} checkpoint=pending pr=${input.pr ?? "none"} processed=${(input.processed ?? []).join(",")} -->`
}

export function parseTriageMarker(body: string): TriageMarker | undefined {
  const match = body.match(/<!--\s*opencode-magi:triage\s+([^>]+?)\s*-->/)
  if (!match) return undefined

  const entries = Object.fromEntries(
    match[1]
      .trim()
      .split(/\s+/)
      .map((part) => {
        const index = part.indexOf("=")
        return index === -1
          ? [part, ""]
          : [part.slice(0, index), part.slice(index + 1)]
      }),
  )
  const version = Number(entries.v)

  if (version !== 1) return undefined

  return {
    action: entries.action,
    checkpoint: entries.checkpoint ? Number(entries.checkpoint) : undefined,
    issue: entries.issue ? Number(entries.issue) : undefined,
    pr: entries.pr,
    processed: entries.processed
      ? entries.processed.split(",").filter(Boolean).map(Number)
      : [],
    result: entries.result,
    v: version,
  }
}

function labelsContain(labels: string[], targets: string[]): boolean {
  const set = new Set(labels.map((label) => label.toLowerCase()))

  return targets.some((target) => set.has(target.toLowerCase()))
}

export function resolveIssueKind(
  issue: IssueMeta,
  repository: ResolvedRepository,
): "BUG" | "FEATURE" | undefined {
  const triage = repository.triage
  if (!triage) throw new Error("triage configuration is required")

  const bug =
    labelsContain(issue.labels, triage.kind.bug.label) ||
    (issue.type != null && triage.kind.bug.type.includes(issue.type))
  const feature =
    labelsContain(issue.labels, triage.kind.feature.label) ||
    (issue.type != null && triage.kind.feature.type.includes(issue.type))

  if (bug === feature) return undefined

  return bug ? "BUG" : "FEATURE"
}

function issueContext(input: {
  issue: IssueMeta
  relationship: RelationshipSummary
}): string {
  return JSON.stringify(
    {
      duplicateCandidates: input.relationship.duplicateCandidates,
      issue: input.issue,
      recentComments: input.relationship.comments.slice(-20),
      relatedPullRequests: input.relationship.relatedPullRequests,
    },
    null,
    2,
  )
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function runVote<T extends string>(input: {
  agent: ResolvedTriageAgent
  client: ModelClient
  context: string
  directory: string
  issue: number
  parse: (text: string) => TriageVoteOutput<T>
  prompt: TriagePromptComposer
  repository: ResolvedRepository
  schemaName: string
  signal?: AbortSignal
}): Promise<TriageVoteOutput<T> & { raw: string; sessionId: string }> {
  const prompt = await input.prompt({
    context: input.context,
    directory: input.directory,
    issue: input.issue,
    repository: input.repository,
    reviewer: input.agent,
  })
  const result = await runModelWithRepair({
    client: input.client,
    model: input.agent.model,
    options: input.agent.options,
    parse: input.parse,
    permission: input.agent.permission,
    prompt,
    repairAttempts: 3,
    schemaName: input.schemaName,
    signal: input.signal,
    title: `Magi triage ${input.schemaName} #${input.issue} (${input.agent.key})`,
  })

  return { ...result.value, raw: result.raw, sessionId: result.sessionId }
}

async function runDuplicateVote(input: {
  context: string
  input: TriageRunInput
  outputDir: string
}): Promise<TriageDuplicateOutput | undefined> {
  const agents = input.input.repository.agents.triage
  if (!agents?.length) throw new Error("triage.agents is required")

  const outputs = await Promise.all(
    agents.map((agent) =>
      runVote<TriageDuplicateVote>({
        agent,
        client: input.input.client,
        context: input.context,
        directory: input.input.directory,
        issue: input.input.issue,
        parse: parseTriageDuplicateOutput,
        prompt: composeTriageDuplicatePrompt,
        repository: input.input.repository,
        schemaName: "triage duplicate",
        signal: input.input.signal,
      }),
    ),
  )
  const majority = aggregateStringMajority(
    outputs.map((output, index) => ({
      reviewer: agents[index].key,
      vote: output.vote,
    })),
    DUPLICATE_VOTES,
  )

  await writeJson(join(input.outputDir, "duplicate-majority.json"), majority)

  if (majority.vote !== "DUPLICATE") return undefined

  return outputs.find((output) => output.vote === "DUPLICATE")
}

async function runPhaseVote<T extends string>(input: {
  context: string
  input: TriageRunInput
  outputDir: string
  parse: (text: string) => TriageVoteOutput<T>
  phase: string
  prompt: TriagePromptComposer
  schemaName: string
  votes: readonly T[]
}): Promise<T | undefined> {
  const agents = input.input.repository.agents.triage
  if (!agents?.length) throw new Error("triage.agents is required")

  const outputs = await Promise.all(
    agents.map((agent) =>
      runVote<T>({
        agent,
        client: input.input.client,
        context: input.context,
        directory: input.input.directory,
        issue: input.input.issue,
        parse: input.parse,
        prompt: input.prompt,
        repository: input.input.repository,
        schemaName: input.schemaName,
        signal: input.input.signal,
      }),
    ),
  )
  const majority = aggregateStringMajority(
    outputs.map((output, index) => ({
      reviewer: agents[index].key,
      vote: output.vote,
    })),
    input.votes,
  )

  await writeJson(
    join(input.outputDir, `${input.phase}-majority.json`),
    majority,
  )

  return majority.vote
}

async function relationshipScan(input: TriageRunInput, issue: IssueMeta) {
  const [comments, relatedPullRequests, duplicateCandidates] =
    await Promise.all([
      fetchIssueComments(input.exec, input.repository, input.issue),
      fetchRelatedPullRequests(input.exec, input.repository, input.issue),
      searchDuplicateIssues(input.exec, input.repository, issue),
    ])
  const previousMarker = comments
    .map((comment) => parseTriageMarker(comment.body))
    .filter((item): item is TriageMarker => Boolean(item))
    .at(-1)

  return { comments, duplicateCandidates, previousMarker, relatedPullRequests }
}

function safetyBlocked(
  input: TriageRunInput,
  issue: IssueMeta,
  hasMarker: boolean,
): string | undefined {
  const triage = input.repository.triage
  if (!triage) throw new Error("triage configuration is required")
  const safety = triage.safety

  if (issue.state === "CLOSED") return "issue is closed"
  if (!hasMarker && safety.requiredLabels.length) {
    const missing = safety.requiredLabels.filter(
      (label) => !labelsContain(issue.labels, [label]),
    )
    if (missing.length) return `missing required labels: ${missing.join(", ")}`
  }
  if (
    safety.blockedLabels.some((label) => labelsContain(issue.labels, [label]))
  ) {
    return "issue has a blocked label"
  }
  if (
    safety.allowAuthors.length &&
    !safety.allowAuthors.includes(issue.author)
  ) {
    return `issue author is not allowed: ${issue.author}`
  }

  return undefined
}

async function createImplementationPr(input: {
  context: string
  input: TriageRunInput
  issue: IssueMeta
  outputDir: string
}): Promise<string | undefined> {
  const creator = input.input.repository.agents.triageCreator
  if (!creator) return undefined

  const branch = `magi/issue-${input.issue.number}-${Date.now().toString(36)}`
  const worktreePath = join(
    worktreeBaseDir(input.input.directory, input.input.config, "issue"),
    `issue-${input.issue.number}`,
  )
  await input.input.exec(
    `git worktree add -b ${shellQuote(branch)} ${shellQuote(worktreePath)}`,
  )
  try {
    await configureGitIdentity(input.input.exec, worktreePath, creator.author)
    const prompt = `Implement issue #${input.issue.number}.\n\n${input.context}\n\nReturn the edit output contract.`
    const result = await runModelWithRepair<EditOutput>({
      client: input.input.client,
      model: creator.model,
      options: creator.options,
      parse: parseEditOutput,
      permission: creator.permission,
      prompt,
      repairAttempts: 3,
      schemaName: "edit",
      signal: input.input.signal,
      title: `Magi triage create PR #${input.issue.number}`,
    })

    await writeJson(join(input.outputDir, "create-pr.json"), result.value)
    if (result.value.mode !== "EDITED") return undefined

    await pushHead(
      input.input.exec,
      input.input.repository,
      worktreePath,
      creator.account,
      {
        owner: input.input.repository.github.owner,
        ref: branch,
        repo: input.input.repository.github.repo,
      },
    )

    return createPullRequest(
      input.input.exec,
      input.input.repository,
      creator.account,
      {
        body: `Closes #${input.issue.number}`,
        head: branch,
        title: `fix: address issue #${input.issue.number}`,
      },
    )
  } finally {
    await removeWorktree(input.input.exec, worktreePath).catch(() => undefined)
  }
}

export async function runTriage(
  input: TriageRunInput,
): Promise<TriageRunResult> {
  const triage = input.repository.triage
  if (!triage?.account) throw new Error("triage.account is required")
  const agents = input.repository.agents.triage
  if (!agents?.length) throw new Error("triage.agents is required")

  const runId = input.runId ?? `run-${Date.now().toString(36)}`
  const outputDir = issueRunOutputDir({
    config: input.config,
    directory: input.directory,
    issue: input.issue,
    runId,
  })
  await mkdir(outputDir, { recursive: true })

  const issue = await fetchIssue(input.exec, input.repository, input.issue)
  const relationship = await relationshipScan(input, issue)
  const block = safetyBlocked(
    input,
    issue,
    Boolean(relationship.previousMarker),
  )

  await writeJson(join(outputDir, "issue.json"), issue)
  await writeJson(join(outputDir, "relationship-summary.json"), relationship)

  if (block) {
    const report = `Magi triage blocked for #${input.issue}: ${block}`
    await writeFile(join(outputDir, "report.md"), `${report}\n`)
    return { issue: input.issue, outputDir, report, result: "FAILED" }
  }

  const context = issueContext({ issue, relationship })

  if (relationship.relatedPullRequests.length) {
    const vote = await runPhaseVote<TriageExistingPrVote>({
      context,
      input,
      outputDir,
      parse: parseTriageExistingPrOutput,
      phase: "existing-pr",
      prompt: composeTriageExistingPrPrompt,
      schemaName: "triage existing PR",
      votes: EXISTING_PR_VOTES,
    })
    if (vote === "RELATED_PR_HANDLES_ISSUE") {
      const merged = relationship.relatedPullRequests.some(
        (pr) => pr.state === "MERGED",
      )
      if (merged && triage.automation.close) {
        const body = `@${issue.author} Magi found a related merged pull request that appears to resolve this issue.\n\n${marker({ action: "CLOSE", issue: issue.number, result: "RESOLVED_BY_MERGED_PR" })}`
        if (!input.dryRun) {
          await postIssueComment(
            input.exec,
            input.repository,
            issue.number,
            triage.account,
            body,
          )
          await closeIssue(
            input.exec,
            input.repository,
            issue.number,
            triage.account,
          )
          await removeIssueLabels(
            input.exec,
            input.repository,
            issue.number,
            triage.automation.clear,
            triage.account,
          )
        }
        const report = `Magi triage closed #${issue.number} because a related PR was merged.`
        await writeFile(join(outputDir, "report.md"), `${report}\n`)
        return {
          issue: issue.number,
          outputDir,
          report,
          result: "BUG_ACCEPTED",
        }
      }
      if (!input.dryRun) {
        await removeIssueLabels(
          input.exec,
          input.repository,
          issue.number,
          triage.automation.clear,
          triage.account,
        )
      }
      const report = `Magi triage cleared #${issue.number} because a related PR handles it.`
      await writeFile(join(outputDir, "report.md"), `${report}\n`)
      return { issue: issue.number, outputDir, report, result: "CLEAR_ONLY" }
    }
  }

  if (relationship.duplicateCandidates.length) {
    const duplicate = await runDuplicateVote({ context, input, outputDir })
    if (duplicate) {
      const body = `@${issue.author} Magi triage found this issue duplicates #${duplicate.duplicateOf}.\n\nReason: ${duplicate.reason}\n\n${marker({ action: "CLOSE", issue: issue.number, result: "DUPLICATE" })}`
      if (!input.dryRun && triage.automation.close) {
        await postIssueComment(
          input.exec,
          input.repository,
          issue.number,
          triage.account,
          body,
        )
        for (const pr of relationship.relatedPullRequests.filter(
          (pr) => pr.state === "OPEN",
        )) {
          await closePullRequest(
            input.exec,
            input.repository,
            pr.number,
            triage.account,
          )
        }
        await closeIssue(
          input.exec,
          input.repository,
          issue.number,
          triage.account,
        )
      }
      if (!input.dryRun) {
        await removeIssueLabels(
          input.exec,
          input.repository,
          issue.number,
          triage.automation.clear,
          triage.account,
        )
      }
      const report = `Magi triage marked #${issue.number} duplicate of #${duplicate.duplicateOf}.`
      await writeFile(join(outputDir, "report.md"), `${report}\n`)
      return { issue: issue.number, outputDir, report, result: "DUPLICATE" }
    }
  }

  const kind =
    resolveIssueKind(issue, input.repository) ??
    (await runPhaseVote<TriageKindVote>({
      context,
      input,
      outputDir,
      parse: parseTriageKindOutput,
      phase: "kind",
      prompt: composeTriageKindPrompt,
      schemaName: "triage kind",
      votes: KIND_VOTES,
    })) ??
    "ASK"

  let result: FinalResult = "ASK"
  if (kind === "BUG") {
    const vote = await runPhaseVote<TriageBinaryVote>({
      context,
      input,
      outputDir,
      parse: parseTriageBinaryOutput,
      phase: "bug",
      prompt: composeTriageBugPrompt,
      schemaName: "triage bug",
      votes: BINARY_VOTES,
    })
    result =
      vote === "YES" ? "BUG_ACCEPTED" : vote === "NO" ? "BUG_REJECTED" : "ASK"
  }
  if (kind === "FEATURE") {
    const vote = await runPhaseVote<TriageBinaryVote>({
      context,
      input,
      outputDir,
      parse: parseTriageBinaryOutput,
      phase: "feature",
      prompt: composeTriageFeaturePrompt,
      schemaName: "triage feature",
      votes: BINARY_VOTES,
    })
    result =
      vote === "YES"
        ? "FEATURE_ACCEPTED"
        : vote === "NO"
          ? "FEATURE_REJECTED"
          : "ASK"
  }

  const needsClose =
    triage.automation.close &&
    (result === "BUG_REJECTED" || result === "FEATURE_REJECTED")
  const needsPr =
    triage.automation.pr &&
    (result === "BUG_ACCEPTED" || result === "FEATURE_ACCEPTED")
  const commentContext = `Result: ${result}\n\n${context}`
  const commentPrompt = composeTriageCommentPrompt({
    author: issue.author,
    context: commentContext,
    directory: input.directory,
    issue: issue.number,
    repository: input.repository,
  })
  const comment =
    (
      await runModelText({
        allowEmpty: false,
        client: input.client,
        model: agents[0].model,
        options: agents[0].options,
        permission: agents[0].permission,
        prompt: commentPrompt,
        signal: input.signal,
        title: `Magi triage comment #${issue.number}`,
      })
    ).raw + `\n\n${marker({ action: result, issue: issue.number, result })}`

  let prUrl: string | undefined
  if (!input.dryRun) {
    await postIssueComment(
      input.exec,
      input.repository,
      issue.number,
      triage.account,
      comment,
    )
    if (needsClose) {
      for (const pr of relationship.relatedPullRequests.filter(
        (pr) => pr.state === "OPEN",
      )) {
        await closePullRequest(
          input.exec,
          input.repository,
          pr.number,
          triage.account,
        )
      }
      await closeIssue(
        input.exec,
        input.repository,
        issue.number,
        triage.account,
      )
    }
    if (needsPr)
      prUrl = await createImplementationPr({ context, input, issue, outputDir })
    if (result !== "ASK") {
      await removeIssueLabels(
        input.exec,
        input.repository,
        issue.number,
        triage.automation.clear,
        triage.account,
      )
    }
  }

  const report = [
    `Magi triage result for #${issue.number}: ${result}`,
    prUrl ? `Created PR: ${prUrl}` : undefined,
    input.dryRun ? "Dry run: no GitHub mutations were performed." : undefined,
  ]
    .filter(Boolean)
    .join("\n")
  await writeFile(join(outputDir, "report.md"), `${report}\n`)

  return { issue: issue.number, outputDir, report, result }
}
