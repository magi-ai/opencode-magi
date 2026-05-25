export type Verdict = "CHANGES_REQUESTED" | "CLOSE" | "MERGE"

export type ModelOptions = Record<string, unknown>

export interface ModelCandidateConfig {
  id: string
  options?: ModelOptions
}

export type ModelConfig =
  | string
  | ModelCandidateConfig
  | (string | ModelCandidateConfig)[]

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
  model: ModelConfig
  permissions?: PermissionConfig
  persona?: string
  ref?: string
}

export interface EditorConfig {
  account: string
  author: {
    email: string
    name: string
  }
  model: ModelConfig
  permissions?: PermissionConfig
  persona?: string
  ref?: string
}

export interface TriageAgentConfig {
  account: string
  id?: string
  model: ModelConfig
  permissions?: PermissionConfig
  persona?: string
  ref?: string
}

export interface TriageCreatorConfig {
  account?: string
  author: {
    email: string
    name: string
  }
  model: ModelConfig
  permissions?: PermissionConfig
  persona?: string
  ref?: string
}

export interface AgentRefConfig {
  account?: string
  author?: {
    email?: string
    name?: string
  }
  id?: string
  model?: ModelConfig
  permissions?: PermissionConfig
  persona?: string
}

export interface AgentsConfig {
  permissions?: PermissionConfig
  refs?: Record<string, AgentRefConfig>
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

export interface MergeAutomationConfig extends AutomationConfig {
  conflict?: boolean
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

export interface TriageConcurrencyConfig {
  runs?: number
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

export interface TriagePromptConfig {
  acceptance?: string
  category?: string
  commentClassification?: string
  create?: string
  createGuidelines?: string
  duplicate?: string
  existingPr?: string
  reconsider?: string
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
  automation?: AutomationConfig
  checks?: ReviewChecksConfig
  concurrency?: ConcurrencyConfig
  merge?: PullRequestMergeConfig
  output?: string
  prompts?: ReviewPromptConfig
  reviewers?: ReviewerConfig[]
  safety?: SafetyConfig
  worktree?: string
}

export interface TriageCategoryConfig {
  description?: string
  id?: string
  labels?: string[]
  types?: string[]
}

export interface TriageSignalConfig {
  description: string
  id: string
}

export interface TriageLabelRuleCondition {
  category?: string
  disposition?: TriageDisposition
  signals?: string[]
}

export interface TriageLabelRuleConfig {
  add?: string[]
  remove?: string[]
  when: TriageLabelRuleCondition
}

export interface TriageAutomationConfig {
  close?: boolean
  create?: boolean
  label?: TriageLabelRuleConfig[]
  merge?: boolean
  review?: boolean
}

export interface TriageSafetyConfig {
  allowAuthors?: string[]
  allowMentionActors?: string[]
  allowMentionRoles?: string[]
  blockedLabels?: string[]
  requiredLabels?: string[]
}

export interface TriageConfig {
  automation?: TriageAutomationConfig
  categories?: TriageCategoryConfig[]
  concurrency?: TriageConcurrencyConfig
  creator?: TriageCreatorConfig
  output?: string
  prompts?: TriagePromptConfig
  reporter?: string
  safety?: TriageSafetyConfig
  signals?: TriageSignalConfig[]
  voters?: TriageAgentConfig[]
  worktree?: string
}

export interface ResolvedTriageCategory {
  description?: string
  id: string
  labels: string[]
  types: string[]
}

export interface MergeConfig {
  automation?: MergeAutomationConfig
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
  triage?: TriageConfig
}

export interface ResolvedReviewer extends Omit<
  ReviewerConfig,
  "model" | "options" | "permissions"
> {
  index: number
  key: string
  model: string
  options?: ModelOptions
  permission: PermissionConfig
}

export interface ResolvedEditor extends Omit<
  EditorConfig,
  "model" | "options" | "permissions"
> {
  model: string
  options?: ModelOptions
  permission: PermissionConfig
}

export interface ResolvedTriageAgent extends Omit<
  TriageAgentConfig,
  "model" | "options" | "permissions"
> {
  index: number
  key: string
  model: string
  options?: ModelOptions
  permission: PermissionConfig
}

export interface ResolvedTriageCreator extends Omit<
  TriageCreatorConfig,
  "model" | "options" | "permissions"
> {
  account: string
  model: string
  options?: ModelOptions
  permission: PermissionConfig
}

export interface ResolvedAgents {
  editor?: ResolvedEditor
  reviewers: ResolvedReviewer[]
  triage?: ResolvedTriageAgent[]
  triageCreator?: ResolvedTriageCreator
}

export interface ResolvedRepository extends RepositoryConfig {
  agents: ResolvedAgents
  automation: Required<AutomationConfig> & { conflict?: boolean }
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
  triage?: {
    automation: Required<TriageAutomationConfig>
    categories: ResolvedTriageCategory[]
    concurrency: Required<TriageConcurrencyConfig>
    output?: string
    prompts: TriagePromptConfig
    reporter?: string
    safety: Required<TriageSafetyConfig>
    signals: TriageSignalConfig[]
    worktree?: string
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

export interface NewFinding {
  body: string
  line: number
  path: string
  startLine?: number
}

export interface ReviewOutput {
  findings: Finding[]
  reason?: string
  verdict: Verdict
}

export interface RereviewOutput {
  followUps: { commentId: number; body: string }[]
  newFindings: NewFinding[]
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
  newFindings: NewFinding[]
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

export type TriageCategoryVote = string
export type TriageBinaryVote = "ASK" | "INVALID" | "NO" | "YES"
export type TriageDuplicateVote = "DUPLICATE" | "NOT_DUPLICATE"
export type TriageExistingPrVote =
  | "RELATED_PR_DOES_NOT_HANDLE_ISSUE"
  | "RELATED_PR_HANDLES_ISSUE"
export type TriageCommentClassification =
  | "ACKNOWLEDGEMENT"
  | "CLARIFICATION"
  | "NEW_EVIDENCE"
  | "OBJECTION"
  | "UNRELATED"
export type TriageAction = "ASK" | "CLEAR_ONLY" | "CLOSE" | "COMMENT" | "PR"
export type TriageDisposition =
  | "accepted"
  | "already_handled"
  | "blocked"
  | "duplicate"
  | "failed"
  | "invalid"
  | "needs_acceptance"
  | "needs_category"
  | "rejected"

export interface TriageDecision {
  category: string | null
  disposition: TriageDisposition
  signals: string[]
}

export interface TriageVoteOutput<T extends string = string> {
  body?: string
  reason: string
  vote: T
}

export interface TriageSignalOutput {
  signals: {
    id: string
    reason: string
  }[]
}

export interface TriageDuplicateOutput extends TriageVoteOutput<TriageDuplicateVote> {
  duplicateOf?: number
}

export interface TriageCommentClassificationOutput {
  comments: {
    classification: TriageCommentClassification
    commentId: number
    reason: string
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
  pullRequest?: {
    body: string
    title: string
  }
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
