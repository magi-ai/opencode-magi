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
  reviewer: { permission?: PermissionConfig },
): PermissionConfig {
  return mergePermissions(
    mergePermissions(DEFAULT_REVIEWER_PERMISSION, agents.permissions),
    reviewer.permission,
  )
}

export function resolveEditorPermission(
  agents: AgentsConfig,
  editor: { permission?: PermissionConfig },
): PermissionConfig {
  return mergePermissions(
    mergePermissions(DEFAULT_EDITOR_PERMISSION, agents.permissions),
    editor.permission,
  )
}

export function resolveAgents(agents: AgentsConfig): ResolvedAgents {
  return {
    editor: agents.editor
      ? {
          ...agents.editor,
          permission: resolveEditorPermission(agents, agents.editor),
        }
      : undefined,
    reviewers: (agents.reviewers ?? []).map<ResolvedReviewer>(
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
    agents: resolveAgents(config.agents),
    automation: {
      close: config.automation?.close ?? true,
      merge: config.automation?.merge ?? true,
    },
    checks: {
      exclude: config.checks?.exclude ?? [],
      waitAfterEdit: config.checks?.waitAfterEdit ?? true,
      waitBeforeReview: config.checks?.waitBeforeReview ?? true,
      retryFailedJobs: config.checks?.retryFailedJobs ?? 3,
    },
    concurrency: {
      runs: config.concurrency?.runs ?? 3,
      reviewers: config.concurrency?.reviewers ?? 3,
    },
    github: {
      apiRetryAttempts: config.github.apiRetryAttempts ?? 3,
      host: config.github.host ?? "github.com",
      owner: config.github.owner,
      repo: config.github.repo,
    },
    language: config.language,
    merge: {
      approvalPolicy: config.merge?.approvalPolicy ?? "majority",
      method: config.merge?.method ?? "squash",
      auto: config.merge?.auto ?? true,
      deleteBranch: config.merge?.deleteBranch ?? true,
      mergeQueue: config.merge?.mergeQueue ?? false,
      maxThreadResolutionCycles: config.merge?.maxThreadResolutionCycles ?? 5,
    },
    prompts: config.prompts ?? {},
    safety: {
      allowAuthors: config.safety?.allowAuthors ?? [],
      blockedPaths: config.safety?.blockedPaths ?? [],
      maxChangedFiles: config.safety?.maxChangedFiles,
      requiredLabels: config.safety?.requiredLabels ?? [],
    },
  }
}
