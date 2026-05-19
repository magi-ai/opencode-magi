export type Verdict = "CHANGES_REQUESTED" | "CLOSE" | "MERGE"

export type ModelOptions = Record<string, unknown>

export type PermissionAction = "allow" | "ask" | "deny"

export type PermissionRuleConfig =
  | PermissionAction
  | Record<string, PermissionAction>

export type PermissionConfig =
  | PermissionAction
  | Record<string, PermissionRuleConfig>

export interface OpenCodePermissionRule {
  action: PermissionAction
  pattern: string
  permission: string
}

export interface ReviewerConfig {
  account: string
  id?: string
  model: string
  options?: ModelOptions
  permissions?: PermissionConfig
  persona?: string
}

export interface EditorConfig {
  account: string
  author: {
    email: string
    name: string
  }
  model: string
  options?: ModelOptions
  permissions?: PermissionConfig
  persona?: string
}

export interface AgentsConfig {
  permissions?: PermissionConfig
}

export interface GitHubRepoConfig {
  apiRetryAttempts?: number
  host?: string
  owner: string
  repo: string
}

export interface PullRequestMergeConfig {
  approvalPolicy?: "majority" | "unanimous"
  auto?: boolean
  deleteBranch?: boolean
  method?: "merge" | "squash" | "rebase"
  queue?: boolean
}

export interface ReviewChecksConfig {
  exclude?: string[]
  retryFailedJobs?: number
  wait?: boolean
}

export interface MergeChecksConfig {
  wait?: boolean
}

export interface AutomationConfig {
  close?: boolean
  merge?: boolean
}

export interface SafetyConfig {
  allowAuthors?: string[]
  blockedPaths?: string[]
  maxChangedFiles?: number
  requiredLabels?: string[]
}

export interface ConcurrencyConfig {
  runs?: number
  reviewers?: number
}

export interface ClearConfig {
  branch?: boolean
  output?: boolean
  session?: boolean
  worktree?: boolean
}

export interface PromptConfig {
  ciClassification?: string
  ciClassificationAfterEdit?: string
  closeReconsideration?: string
  edit?: string
  editGuidelines?: string
  findingValidation?: string
  rereview?: string
  rereviewCloseReconsideration?: string
  review?: string
  reviewGuidelines?: string
}

export interface ReviewPromptConfig {
  ciClassification?: string
  closeReconsideration?: string
  findingValidation?: string
  rereview?: string
  review?: string
  reviewGuidelines?: string
}

export interface MergePromptConfig {
  ciClassification?: string
  edit?: string
  editGuidelines?: string
}

export interface RepositoryConfig {
  alias: string
  github: GitHubRepoConfig
  language?: string
}

export interface OutputConfig {
  repairAttempts?: number
}

export interface ReviewConfig {
  agents?: ReviewerConfig[]
  automation?: AutomationConfig
  checks?: ReviewChecksConfig
  concurrency?: ConcurrencyConfig
  merge?: PullRequestMergeConfig
  output?: string
  prompts?: ReviewPromptConfig
  safety?: SafetyConfig
  worktree?: string
}

export interface MergeConfig {
  automation?: AutomationConfig
  checks?: MergeChecksConfig
  editor?: EditorConfig
  maxThreadResolutionCycles?: number
  prompts?: MergePromptConfig
}

export interface MagiConfig {
  $schema?: string
  agents?: AgentsConfig
  clear?: ClearConfig
  github?: GitHubRepoConfig
  language?: string
  merge?: MergeConfig
  output?: OutputConfig
  review?: ReviewConfig
}

export interface ResolvedReviewer extends Omit<ReviewerConfig, "permissions"> {
  index: number
  key: string
  permission: PermissionConfig
}

export interface ResolvedEditor extends Omit<EditorConfig, "permissions"> {
  permission: PermissionConfig
}

export interface ResolvedAgents {
  editor?: ResolvedEditor
  reviewers: ResolvedReviewer[]
}

export interface ResolvedRepository extends RepositoryConfig {
  agents: ResolvedAgents
  automation: Required<AutomationConfig>
  checks: {
    exclude: string[]
    retryFailedJobs: number
    wait?: boolean
    waitAfterEdit: boolean
    waitBeforeReview: boolean
  }
  concurrency: Required<ConcurrencyConfig>
  github: Required<GitHubRepoConfig>
  language?: string
  merge: Required<Omit<PullRequestMergeConfig, "queue">> & {
    maxThreadResolutionCycles: number
    mergeQueue: boolean
    queue?: boolean
  }
  prompts: PromptConfig
  reviewAutomation?: Required<AutomationConfig>
  safety: Required<Omit<SafetyConfig, "maxChangedFiles">> & {
    maxChangedFiles?: number
  }
}

export interface Finding {
  fix: string
  issue: string
  line: number
  path: string
  perspective?: string
  startLine?: number
}

export interface ReviewOutput {
  findings: Finding[]
  reason?: string
  verdict: Verdict
}

export interface RereviewOutput {
  followUps: { commentId: number; body: string }[]
  newFindings: {
    path: string
    line: number
    startLine?: number
    body: string
  }[]
  reason?: string
  resolve: { commentId: number; threadId: string }[]
  verdict: Verdict
}

export interface CloseReconsiderationOutput {
  findings: Finding[]
  verdict: Exclude<Verdict, "CLOSE">
}

export interface RereviewCloseReconsiderationOutput {
  followUps: { commentId: number; body: string }[]
  newFindings: {
    path: string
    line: number
    startLine?: number
    body: string
  }[]
  resolve: { commentId: number; threadId: string }[]
  verdict: Exclude<Verdict, "CLOSE">
}

export interface FindingValidationOutput {
  votes: {
    findingIndex: number
    reason?: string
    reviewer: string
    vote: "AGREE" | "DISAGREE"
  }[]
}

export type EditResponseAction = "ASK" | "DISAGREE" | "FIXED"

export interface EditResponse {
  action: EditResponseAction
  body: string
  commentId: number
}

export interface EditOutput {
  commitMessage?: string
  commitSha?: string
  filesTouched: string[]
  mode: "EDITED" | "REPLIED"
  responses: EditResponse[]
}

export type Exec = (
  command: string,
  options?: {
    cwd?: string
    env?: Record<string, string>
    signal?: AbortSignal
  },
) => Promise<string>
