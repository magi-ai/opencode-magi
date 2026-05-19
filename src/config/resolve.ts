import type {
  AgentsConfig,
  MagiConfig,
  PermissionConfig,
  PermissionRuleConfig,
  ResolvedAgents,
  ResolvedRepository,
  ResolvedReviewer,
} from "../types"
import editorPermission from "../permissions/editor.json" with { type: "json" }
import commonPermission from "../permissions/common.json" with { type: "json" }

const ID_PATTERN = /^[A-Za-z0-9_-]+$/

const DEFAULT_COMMON_PERMISSION = commonPermission as PermissionConfig
const DEFAULT_REVIEWER_PERMISSION = DEFAULT_COMMON_PERMISSION
const DEFAULT_EDITOR_PERMISSION = mergePermissions(
  DEFAULT_COMMON_PERMISSION,
  editorPermission as PermissionConfig,
)

export function reviewerKey(reviewer: { id?: string }, index: number): string {
  return reviewer.id ?? `reviewer-${index + 1}`
}

export function validateReviewerId(id: string): boolean {
  return ID_PATTERN.test(id)
}

function clonePermissionValue(
  value: PermissionRuleConfig,
): PermissionRuleConfig {
  return typeof value === "string" ? value : { ...value }
}

export function mergePermissions(
  base: PermissionConfig,
  override?: PermissionConfig,
): PermissionConfig {
  if (!override) {
    return typeof base === "string"
      ? base
      : Object.fromEntries(
          Object.entries(base).map(([key, value]) => [
            key,
            clonePermissionValue(value),
          ]),
        )
  }
  if (typeof override === "string") return override
  if (typeof base === "string") {
    return Object.fromEntries(
      Object.entries(override).map(([key, value]) => [
        key,
        clonePermissionValue(value),
      ]),
    )
  }

  const merged: Record<string, PermissionRuleConfig> = Object.fromEntries(
    Object.entries(base).map(([key, value]) => [
      key,
      clonePermissionValue(value),
    ]),
  )

  for (const [permission, value] of Object.entries(override)) {
    const existing = merged[permission]

    merged[permission] =
      existing && typeof existing !== "string" && typeof value !== "string"
        ? { ...existing, ...value }
        : clonePermissionValue(value)
  }

  return merged
}

export function resolveReviewerPermission(
  agents: AgentsConfig,
  reviewer: { permissions?: PermissionConfig },
): PermissionConfig {
  return mergePermissions(
    mergePermissions(DEFAULT_REVIEWER_PERMISSION, agents.permissions),
    reviewer.permissions,
  )
}

export function resolveEditorPermission(
  agents: AgentsConfig,
  editor: { permissions?: PermissionConfig },
): PermissionConfig {
  return mergePermissions(
    mergePermissions(DEFAULT_EDITOR_PERMISSION, agents.permissions),
    editor.permissions,
  )
}

export function resolveAgents(config: MagiConfig): ResolvedAgents {
  const agents = config.agents ?? {}
  const editor = config.merge?.editor

  return {
    editor: editor
      ? {
          ...editor,
          permission: resolveEditorPermission(agents, editor),
        }
      : undefined,
    reviewers: (config.review?.agents ?? []).map<ResolvedReviewer>(
      (reviewer, index) => ({
        ...reviewer,
        key: reviewerKey(reviewer, index),
        index,
        permission: resolveReviewerPermission(agents, reviewer),
      }),
    ),
  }
}

export function resolveRepository(config: MagiConfig): ResolvedRepository {
  if (!config.github?.owner) throw new Error("github.owner is required")
  if (!config.github?.repo) throw new Error("github.repo is required")

  return {
    alias: config.github.repo,
    agents: resolveAgents(config),
    automation: {
      close: config.merge?.automation?.close ?? false,
      merge: config.merge?.automation?.merge ?? true,
    },
    checks: {
      exclude: config.review?.checks?.exclude ?? [],
      retryFailedJobs: config.review?.checks?.retryFailedJobs ?? 3,
      wait: config.review?.checks?.wait ?? true,
      waitAfterEdit: config.merge?.checks?.wait ?? true,
      waitBeforeReview: config.review?.checks?.wait ?? true,
    },
    concurrency: {
      runs: config.review?.concurrency?.runs ?? 3,
      reviewers: config.review?.concurrency?.reviewers ?? 3,
    },
    github: {
      apiRetryAttempts: config.github.apiRetryAttempts ?? 3,
      host: config.github.host ?? "github.com",
      owner: config.github.owner,
      repo: config.github.repo,
    },
    language: config.language,
    merge: {
      approvalPolicy: config.review?.merge?.approvalPolicy ?? "majority",
      method: config.review?.merge?.method ?? "squash",
      auto: config.review?.merge?.auto ?? true,
      deleteBranch: config.review?.merge?.deleteBranch ?? true,
      queue: config.review?.merge?.queue ?? false,
      mergeQueue: config.review?.merge?.queue ?? false,
      maxThreadResolutionCycles: config.merge?.maxThreadResolutionCycles ?? 5,
    },
    prompts: {
      ciClassification: config.review?.prompts?.ciClassification,
      ciClassificationAfterEdit: config.merge?.prompts?.ciClassification,
      closeReconsideration: config.review?.prompts?.closeReconsideration,
      edit: config.merge?.prompts?.edit,
      editGuidelines: config.merge?.prompts?.editGuidelines,
      findingValidation: config.review?.prompts?.findingValidation,
      rereview: config.review?.prompts?.rereview,
      review: config.review?.prompts?.review,
      reviewGuidelines: config.review?.prompts?.reviewGuidelines,
    },
    reviewAutomation: {
      close: config.review?.automation?.close ?? false,
      merge: config.review?.automation?.merge ?? true,
    },
    safety: {
      allowAuthors: config.review?.safety?.allowAuthors ?? [],
      blockedPaths: config.review?.safety?.blockedPaths ?? [],
      maxChangedFiles: config.review?.safety?.maxChangedFiles,
      requiredLabels: config.review?.safety?.requiredLabels ?? [],
    },
  }
}
