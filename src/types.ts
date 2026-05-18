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
  permission?: PermissionConfig
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
  permission?: PermissionConfig
  persona?: string
}

export interface AgentsConfig {
  editor?: EditorConfig
  permissions?: PermissionConfig
  reviewers?: ReviewerConfig[]
}

export interface GitHubRepoConfig {
  apiRetryAttempts?: number
  host?: string
  owner: string
  repo: string
}

export interface MergeConfig {
  approvalPolicy?: "majority" | "unanimous"
  auto?: boolean
  deleteBranch?: boolean
  maxThreadResolutionCycles?: number
  mergeQueue?: boolean
  method?: "merge" | "squash" | "rebase"
}

export interface ChecksConfig {
  exclude?: string[]
  retryFailedJobs?: number
  waitAfterEdit?: boolean
  waitBeforeReview?: boolean
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
  report?: string
  rereview?: string
  rereviewCloseReconsideration?: string
  review?: string
  reviewGuidelines?: string
}

export interface WorktreeConfig {
  dir?: string
}

export interface RepositoryConfig {
  alias: string
  checks?: ChecksConfig
  github: GitHubRepoConfig
  language?: string
  merge?: MergeConfig
  prompts?: PromptConfig
}

export interface OutputConfig {
  dirs?: Partial<Record<"pr", string>>
  repairAttempts?: number
}

export interface MagiConfig {
  $schema?: string
  agents: AgentsConfig
  automation?: AutomationConfig
  clear?: ClearConfig
  checks?: ChecksConfig
  concurrency?: ConcurrencyConfig
  github?: GitHubRepoConfig
  language?: string
  merge?: MergeConfig
  output?: OutputConfig
  prompts?: PromptConfig
  safety?: SafetyConfig
  worktree?: WorktreeConfig
}

export interface ResolvedReviewer extends ReviewerConfig {
  index: number
  key: string
  permission: PermissionConfig
}

export interface ResolvedEditor extends EditorConfig {
  permission: PermissionConfig
}

export interface ResolvedAgents {
  editor?: ResolvedEditor
  reviewers: ResolvedReviewer[]
}

export interface ResolvedRepository extends RepositoryConfig {
  agents: ResolvedAgents
  automation: Required<AutomationConfig>
  checks: Required<ChecksConfig>
  concurrency: Required<ConcurrencyConfig>
  github: Required<GitHubRepoConfig>
  language?: string
  merge: Required<MergeConfig>
  prompts: PromptConfig
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
