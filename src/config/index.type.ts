export type Target = "global" | "project"

export interface Root {
  $schema?: string
  account?: string
  agents: Agents
  clear: Clear
  github: GitHub
  language: string
  merge: Merge
  mode: Mode
  output: Output
  review: Review
  triage: Triage
}

export type Mode = "multi" | "single"

export interface GitHub {
  host: string
  owner: string
  repo: string
  retryApiAttempts: number
  url: string
}

export interface Clear {
  branch: boolean
  output: boolean
  session: boolean
  worktree: boolean
}

export interface Output {
  repairAttempts: number
}

export type PermissionAction = "allow" | "ask" | "deny"
export type PermissionRule =
  | PermissionAction
  | { [key: string]: PermissionAction }
export type Permissions = PermissionAction | { [key: string]: PermissionRule }

export interface ModelWithOptions {
  id: string
  variant?: string
}

export type Model = (ModelWithOptions | string)[] | ModelWithOptions | string

export interface Author {
  email: string
  name: string
}

export interface AgentRef {
  account?: string
  author?: Partial<Author>
  id?: string
  model?: Model
  permissions?: Permissions
  persona?: string
}

export interface Agents {
  permissions: Permissions
  refs?: { [key: string]: AgentRef }
}

export type Agent = Creator | Editor | Reviewer | Voter

export interface Reviewer extends Omit<AgentRef, "author" | "id"> {
  id: string
  ref?: string
}

export type ReviewConditionFilter =
  | { exclude: string[]; include: string[] }
  | { exclude: string[] }
  | { include: string[] }

export type ReviewConditionRole =
  | "COLLABORATOR"
  | "CONTRIBUTOR"
  | "FIRST_TIME_CONTRIBUTOR"
  | "FIRST_TIMER"
  | "MANNEQUIN"
  | "MEMBER"
  | "NONE"
  | "OWNER"

export type ReviewConditionRoleFilter =
  | { exclude: ReviewConditionRole[]; include: ReviewConditionRole[] }
  | { exclude: ReviewConditionRole[] }
  | { include: ReviewConditionRole[] }

export type ReviewConditionBranchFilter =
  | { base: ReviewConditionFilter; head: ReviewConditionFilter }
  | { base: ReviewConditionFilter }
  | { head: ReviewConditionFilter }

export interface ReviewCondition {
  authors?: ReviewConditionFilter
  branches?: ReviewConditionBranchFilter
  labels?: ReviewConditionFilter
  maxChangedFiles?: number
  paths?: ReviewConditionFilter
  roles?: ReviewConditionRoleFilter
}

export type ReviewConditions = [boolean, ReviewCondition][] | boolean

export interface ReviewAutomationCondition extends Omit<
  ReviewCondition,
  "maxChangedFiles"
> {}

export type ReviewAutomationConditions =
  | [boolean, ReviewAutomationCondition][]
  | boolean

export interface Review {
  automation: {
    close: ReviewAutomationConditions
    merge: ReviewAutomationConditions
  }
  checks: {
    exclude: string[]
    retryFailedJobs: number
    wait: boolean
  }
  concurrency: {
    reviewers: number
    runs: number
  }
  merge: {
    approvalPolicy: "majority" | "unanimous"
    auto: boolean
    deleteBranch: boolean
    method: "merge" | "rebase" | "squash"
    queue: boolean
  }
  operator?: string
  output: string
  prompts?: {
    ciClassification?: string
    closeReconsideration?: string
    findingValidation?: string
    rereview?: string
    review?: string
    reviewGuidelines?: string
  }
  reviewers?: Reviewer[]
  safety: ReviewConditions
  worktree: string
}

export interface Editor extends Omit<Reviewer, "id"> {
  author?: Author
}

export interface MergeAutomationCondition extends Omit<
  ReviewCondition,
  "maxChangedFiles"
> {
  edited?: boolean
}

export type MergeAutomationConditions =
  | [boolean, MergeAutomationCondition][]
  | boolean

export interface Merge {
  automation: {
    close: MergeAutomationConditions
    conflict: ReviewAutomationConditions
    merge: MergeAutomationConditions
  }
  checks: {
    wait: boolean
  }
  editor?: Editor
  maxThreadResolutionCycles: number
  prompts?: {
    ciClassification?: string
    edit?: string
    editGuidelines?: string
  }
}

export interface Voter extends Reviewer {}

export interface Creator extends Editor {}

export interface Triage {
  automation: {
    close: boolean
    create: boolean
    label: {
      add?: string[]
      remove?: string[]
      when: {
        category?: string
        disposition?:
          | "accepted"
          | "already_handled"
          | "blocked"
          | "duplicate"
          | "failed"
          | "invalid"
          | "needs_acceptance"
          | "needs_category"
          | "rejected"
        signals?: string[]
      }
    }[]
    merge: boolean
    review: boolean
  }
  categories: {
    description: string
    id: string
    labels?: string[]
    types?: string[]
  }[]
  concurrency: {
    runs: number
  }
  creator?: Creator
  operator?: string
  output: string
  prompts?: {
    acceptance?: string
    category?: string
    commentClassification?: string
    create?: string
    createGuidelines?: string
    duplicate?: string
    existingPr?: string
    reconsider?: string
  }
  safety: {
    allowAuthors: string[]
    allowMentionActors: string[]
    allowMentionRoles: string[]
    blockedLabels: string[]
    requiredLabels: string[]
  }
  signals?: {
    description: string
    id: string
  }[]
  voters?: Voter[]
  worktree: string
}
