import type {
  ResolvedRepository,
  ResolvedReviewer,
  ResolvedTriageAgent,
} from "../types"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import {
  ciClassificationAfterEditOutputContract,
  ciClassificationOutputContract,
  closeReconsiderationOutputContract,
  editOutputContract,
  findingValidationOutputContract,
  rereviewCloseReconsiderationOutputContract,
  rereviewOutputContract,
  reviewOutputContract,
  triageCommentClassificationOutputContract,
  triageCreatePrOutputContract,
  triageDuplicateOutputContract,
  triageSignalOutputContract,
  triageVoteOutputContract,
} from "./contracts"

export interface ReviewPromptInput {
  baseSha: string
  ciFailureContext?: string
  directory: string
  headSha: string
  pr: number
  repository: ResolvedRepository
  reviewContext?: string
  reviewer: ResolvedReviewer
  worktreePath: string
}

export interface RereviewPromptInput extends ReviewPromptInput {
  includeReviewGuidelines?: boolean
  includeSessionContext?: boolean
  previousReview?: string
  previousHeadSha: string
  unresolvedThreads: string
}

export interface EditPromptInput {
  directory: string
  pr: number
  repository: ResolvedRepository
  reviewFindings: string
  unresolvedThreads: string
  worktreePath: string
}

export interface FindingValidationPromptInput extends ReviewPromptInput {
  findings: string
  includeReviewGuidelines?: boolean
  includeSessionContext?: boolean
}

export interface CloseReconsiderationPromptInput extends ReviewPromptInput {
  closeReason?: string
  includeReviewGuidelines?: boolean
  includeSessionContext?: boolean
}

export interface RereviewCloseReconsiderationPromptInput extends ReviewPromptInput {
  closeReason?: string
  includeReviewGuidelines?: boolean
  includeSessionContext?: boolean
  previousHeadSha: string
}

export interface CiClassificationPromptInput {
  checks: {
    evidence: {
      errorMessages: string[]
      failingFiles: string[]
      failingTests: string[]
      relevantFrames: string[]
      representativeLog: string
    }
    link: string
    name: string
    state: string
    workflow: string
  }[]
  directory: string
  pr: number
  repository: ResolvedRepository
}

export interface CiClassificationAfterEditPromptInput extends CiClassificationPromptInput {
  cycle: number
  headSha: string
  previousHeadSha: string
  worktreePath: string
}

export interface TriagePromptInput {
  context: string
  directory: string
  issue: number
  repository: ResolvedRepository
  voter: ResolvedTriageAgent
}

export interface TriageCreatePrPromptInput {
  context: string
  directory: string
  issue: number
  repository: ResolvedRepository
  worktreePath: string
}

async function readOptionalPrompt(
  directory: string,
  path?: string,
  values: Record<string, string> = {},
): Promise<string> {
  if (!path) return ""

  const fullPath = promptPath(directory, path)
  return renderTemplate(await readFile(fullPath, "utf8"), values)
}

function promptPath(directory: string, path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return isAbsolute(path) ? path : join(directory, path)
}

async function readTemplate(name: string): Promise<string> {
  return readFile(new URL(`./templates/${name}.md`, import.meta.url), "utf8")
}

function renderTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replaceAll(
    /\{([A-Za-z0-9_]+)\}/g,
    (match, key) => values[key] ?? match,
  )
}

async function taskBlock(input: {
  builtin: string
  customPath?: string
  directory: string
  values: Record<string, string>
}): Promise<string> {
  const body = input.customPath
    ? await readOptionalPrompt(input.directory, input.customPath, input.values)
    : renderTemplate(await readTemplate(input.builtin), input.values)

  return `<task>\n${body.trim()}\n</task>`
}

function repositoryValues(
  repository: ResolvedRepository,
): Record<string, string> {
  return {
    owner: repository.github.owner,
    repo: repository.github.repo,
  }
}

function reviewValues(input: ReviewPromptInput): Record<string, string> {
  const ciFailureContext = input.ciFailureContext?.trim() ?? ""

  return {
    ...repositoryValues(input.repository),
    baseSha: input.baseSha,
    ciFailureContext,
    ciFailureContextBlock: ciFailureContext
      ? `<ci_failure_context>\n${ciFailureContext}\n</ci_failure_context>`
      : "",
    headSha: input.headSha,
    jsonEncodedWorktreePath: JSON.stringify(input.worktreePath),
    pr: String(input.pr),
    reviewContext: input.reviewContext ?? "",
    worktreePath: input.worktreePath,
  }
}

function rereviewValues(input: RereviewPromptInput): Record<string, string> {
  return {
    ...reviewValues(input),
    previousHeadSha: input.previousHeadSha,
    previousReview: input.previousReview ?? "",
    previousReviewBlock: previousReviewBlock(input.previousReview),
    unresolvedThreads: input.unresolvedThreads,
  }
}

function editValues(input: EditPromptInput): Record<string, string> {
  return {
    ...repositoryValues(input.repository),
    pr: String(input.pr),
    reviewFindings: input.reviewFindings,
    unresolvedThreads: input.unresolvedThreads,
    worktreePath: input.worktreePath,
  }
}

function triageValues(input: {
  author?: string
  context: string
  issue: number
  repository: ResolvedRepository
  worktreePath?: string
}): Record<string, string> {
  const categories = input.repository.triage?.categories ?? []
  const categoryOptions = categories
    .map((category) =>
      category.description
        ? `- ${category.id}: ${category.description}`
        : `- ${category.id}`,
    )
    .join("\n")
  const signalOptions = (input.repository.triage?.signals ?? [])
    .map((signal) => `- ${signal.id}: ${signal.description}`)
    .join("\n")

  return {
    ...repositoryValues(input.repository),
    author: input.author ?? "",
    categoryOptions,
    context: input.context,
    issue: String(input.issue),
    signalOptions,
    worktreePath: input.worktreePath ?? "",
  }
}

function personaBlock(persona?: string): string {
  return persona ? `<persona>\n${persona}\n</persona>` : ""
}

function languageBlock(language?: string): string {
  return language ? `<language>\n${language}\n</language>` : ""
}

function previousReviewBlock(previousReview?: string): string {
  return previousReview?.trim()
    ? `<previous_review>\n${previousReview.trim()}\n</previous_review>`
    : ""
}

function reviewContextBlock(reviewContext?: string): string {
  return reviewContext?.trim() ? reviewContext.trim() : ""
}

async function reviewGuidelinesBlock(input: {
  directory: string
  path?: string
  values: Record<string, string>
}): Promise<string> {
  const body = (
    await readOptionalPrompt(input.directory, input.path, input.values)
  ).trim()

  return body ? `<review_guidelines>\n${body}\n</review_guidelines>` : ""
}

async function editGuidelinesBlock(input: {
  directory: string
  path?: string
  values: Record<string, string>
}): Promise<string> {
  const body = (
    await readOptionalPrompt(input.directory, input.path, input.values)
  ).trim()

  return body ? `<edit_guidelines>\n${body}\n</edit_guidelines>` : ""
}

async function createGuidelinesBlock(input: {
  directory: string
  path?: string
  values: Record<string, string>
}): Promise<string> {
  const body = (
    await readOptionalPrompt(input.directory, input.path, input.values)
  ).trim()

  return body ? `<create_guidelines>\n${body}\n</create_guidelines>` : ""
}

async function sessionContextBlocks(input: {
  directory: string
  includeReviewGuidelines?: boolean
  includeSessionContext?: boolean
  repository: ResolvedRepository
  reviewer: ResolvedReviewer
  values: Record<string, string>
}): Promise<string[]> {
  return [
    input.includeSessionContext
      ? reviewContextBlock(input.values.reviewContext)
      : "",
    input.includeSessionContext ? languageBlock(input.repository.language) : "",
    input.includeSessionContext ? personaBlock(input.reviewer.persona) : "",
    input.includeReviewGuidelines
      ? await reviewGuidelinesBlock({
          directory: input.directory,
          path: input.repository.prompts.reviewGuidelines,
          values: input.values,
        })
      : "",
  ]
}

export async function composeReviewPrompt(
  input: ReviewPromptInput,
): Promise<string> {
  const values = reviewValues(input)
  const task = await taskBlock({
    builtin: "review/review",
    customPath: input.repository.prompts.review,
    directory: input.directory,
    values,
  })

  return [
    task,
    reviewContextBlock(input.reviewContext),
    languageBlock(input.repository.language),
    personaBlock(input.reviewer.persona),
    await reviewGuidelinesBlock({
      directory: input.directory,
      path: input.repository.prompts.reviewGuidelines,
      values,
    }),
    reviewOutputContract,
  ]
    .filter(Boolean)
    .join("\n\n")
}

export async function composeRereviewPrompt(
  input: RereviewPromptInput,
): Promise<string> {
  const values = rereviewValues(input)
  const task = await taskBlock({
    builtin: "review/rereview",
    customPath: input.repository.prompts.rereview,
    directory: input.directory,
    values,
  })

  return [
    task,
    reviewContextBlock(input.reviewContext),
    input.includeSessionContext === false
      ? ""
      : languageBlock(input.repository.language),
    input.includeSessionContext === false
      ? ""
      : personaBlock(input.reviewer.persona),
    input.includeReviewGuidelines === false
      ? ""
      : await reviewGuidelinesBlock({
          directory: input.directory,
          path: input.repository.prompts.reviewGuidelines,
          values,
        }),
    rereviewOutputContract,
  ]
    .filter(Boolean)
    .join("\n\n")
}

export async function composeEditPrompt(
  input: EditPromptInput,
): Promise<string> {
  const values = editValues(input)
  const task = await taskBlock({
    builtin: "merge/edit",
    customPath: input.repository.prompts.edit,
    directory: input.directory,
    values,
  })
  const persona = input.repository.agents.editor?.persona

  return [
    task,
    languageBlock(input.repository.language),
    personaBlock(persona),
    await editGuidelinesBlock({
      directory: input.directory,
      path: input.repository.prompts.editGuidelines,
      values,
    }),
    editOutputContract,
  ]
    .filter(Boolean)
    .join("\n\n")
}

export async function composeFindingValidationPrompt(
  input: FindingValidationPromptInput,
): Promise<string> {
  const values = { ...reviewValues(input), findings: input.findings }
  const task = await taskBlock({
    builtin: "review/finding-validation",
    customPath: input.repository.prompts.findingValidation,
    directory: input.directory,
    values,
  })

  return [
    task,
    ...(await sessionContextBlocks({
      directory: input.directory,
      includeReviewGuidelines: input.includeReviewGuidelines,
      includeSessionContext: input.includeSessionContext,
      repository: input.repository,
      reviewer: input.reviewer,
      values,
    })),
    findingValidationOutputContract,
  ]
    .filter(Boolean)
    .join("\n\n")
}

export async function composeCloseReconsiderationPrompt(
  input: CloseReconsiderationPromptInput,
): Promise<string> {
  const values = {
    ...reviewValues(input),
    closeReason: input.closeReason ?? "",
  }
  const task = await taskBlock({
    builtin: "review/close-reconsideration",
    customPath: input.repository.prompts.closeReconsideration,
    directory: input.directory,
    values,
  })

  return [
    task,
    ...(await sessionContextBlocks({
      directory: input.directory,
      includeReviewGuidelines: input.includeReviewGuidelines,
      includeSessionContext: input.includeSessionContext,
      repository: input.repository,
      reviewer: input.reviewer,
      values,
    })),
    closeReconsiderationOutputContract,
  ]
    .filter(Boolean)
    .join("\n\n")
}

export async function composeRereviewCloseReconsiderationPrompt(
  input: RereviewCloseReconsiderationPromptInput,
): Promise<string> {
  const values = {
    ...reviewValues(input),
    closeReason: input.closeReason ?? "",
    previousHeadSha: input.previousHeadSha,
  }
  const task = await taskBlock({
    builtin: "review/close-reconsideration",
    customPath: input.repository.prompts.closeReconsideration,
    directory: input.directory,
    values,
  })

  return [
    task,
    ...(await sessionContextBlocks({
      directory: input.directory,
      includeReviewGuidelines: input.includeReviewGuidelines,
      includeSessionContext: input.includeSessionContext,
      repository: input.repository,
      reviewer: input.reviewer,
      values,
    })),
    rereviewCloseReconsiderationOutputContract,
  ]
    .filter(Boolean)
    .join("\n\n")
}

export async function composeCiClassificationPrompt(
  input: CiClassificationPromptInput,
): Promise<string> {
  const values = {
    ...repositoryValues(input.repository),
    failedChecks: JSON.stringify(input.checks, null, 2),
    pr: String(input.pr),
  }
  const task = await taskBlock({
    builtin: "review/ci-classification",
    customPath: input.repository.prompts.ciClassification,
    directory: input.directory,
    values,
  })

  return [
    task,
    languageBlock(input.repository.language),
    ciClassificationOutputContract,
  ]
    .filter(Boolean)
    .join("\n\n")
}

export async function composeCiClassificationAfterEditPrompt(
  input: CiClassificationAfterEditPromptInput,
): Promise<string> {
  const values = {
    ...repositoryValues(input.repository),
    cycle: String(input.cycle),
    failedChecks: JSON.stringify(input.checks, null, 2),
    headSha: input.headSha,
    jsonEncodedWorktreePath: JSON.stringify(input.worktreePath),
    previousHeadSha: input.previousHeadSha,
    pr: String(input.pr),
    worktreePath: input.worktreePath,
  }
  const task = await taskBlock({
    builtin: "merge/ci-classification",
    customPath:
      input.repository.prompts.ciClassificationAfterEdit ??
      input.repository.prompts.ciClassification,
    directory: input.directory,
    values,
  })

  return [
    task,
    languageBlock(input.repository.language),
    ciClassificationAfterEditOutputContract,
  ]
    .filter(Boolean)
    .join("\n\n")
}

async function composeTriageVotePrompt(input: {
  builtin: string
  context: string
  customPath?: string
  directory: string
  issue: number
  outputContract: string
  repository: ResolvedRepository
  voter: ResolvedTriageAgent
}): Promise<string> {
  const values = triageValues(input)
  const task = await taskBlock({
    builtin: `triage/${input.builtin}`,
    customPath: input.customPath,
    directory: input.directory,
    values,
  })

  return [
    task,
    languageBlock(input.repository.language),
    personaBlock(input.voter.persona),
    input.outputContract,
  ]
    .filter(Boolean)
    .join("\n\n")
}

export async function composeTriageCreatePrPrompt(
  input: TriageCreatePrPromptInput,
): Promise<string> {
  const values = triageValues(input)
  const task = await taskBlock({
    builtin: "triage/create",
    customPath: input.repository.triage?.prompts.create,
    directory: input.directory,
    values,
  })
  const persona = input.repository.agents.triageCreator?.persona

  return [
    task,
    languageBlock(input.repository.language),
    personaBlock(persona),
    await createGuidelinesBlock({
      directory: input.directory,
      path: input.repository.triage?.prompts.createGuidelines,
      values,
    }),
    triageCreatePrOutputContract,
  ]
    .filter(Boolean)
    .join("\n\n")
}

export async function composeTriageExistingPrPrompt(
  input: TriagePromptInput,
): Promise<string> {
  return composeTriageVotePrompt({
    ...input,
    builtin: "existing-pr",
    customPath: input.repository.triage?.prompts.existingPr,
    outputContract: triageVoteOutputContract(
      '"RELATED_PR_HANDLES_ISSUE" | "RELATED_PR_DOES_NOT_HANDLE_ISSUE"',
    ),
  })
}

export async function composeTriageDuplicatePrompt(
  input: TriagePromptInput,
): Promise<string> {
  return composeTriageVotePrompt({
    ...input,
    builtin: "duplicate",
    customPath: input.repository.triage?.prompts.duplicate,
    outputContract: triageDuplicateOutputContract,
  })
}

export async function composeTriageCategoryPrompt(
  input: TriagePromptInput,
): Promise<string> {
  const categories = input.repository.triage?.categories ?? []
  const votes = ["ASK", ...categories.map((category) => category.id)]
    .map((vote) => JSON.stringify(vote))
    .join(" | ")

  return composeTriageVotePrompt({
    ...input,
    builtin: "category",
    customPath: input.repository.triage?.prompts.category,
    outputContract: triageVoteOutputContract(votes),
  })
}

export async function composeTriageAcceptancePrompt(
  input: TriagePromptInput,
): Promise<string> {
  return composeTriageVotePrompt({
    ...input,
    builtin: "acceptance",
    customPath: input.repository.triage?.prompts.acceptance,
    outputContract: triageVoteOutputContract(
      '"YES" | "NO" | "INVALID" | "ASK"',
    ),
  })
}

export async function composeTriageSignalPrompt(
  input: TriagePromptInput,
): Promise<string> {
  return composeTriageVotePrompt({
    ...input,
    builtin: "signal",
    outputContract: triageSignalOutputContract,
  })
}

export async function composeTriageCommentClassificationPrompt(
  input: TriagePromptInput,
): Promise<string> {
  return composeTriageVotePrompt({
    ...input,
    builtin: "comment-classification",
    customPath: input.repository.triage?.prompts.commentClassification,
    outputContract: triageCommentClassificationOutputContract,
  })
}

export async function composeTriageReconsiderPrompt(
  input: TriagePromptInput,
): Promise<string> {
  return composeTriageVotePrompt({
    ...input,
    builtin: "reconsider",
    customPath: input.repository.triage?.prompts.reconsider,
    outputContract: triageVoteOutputContract('"YES" | "NO" | "ASK"'),
  })
}
