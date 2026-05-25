import type {
  AgentsConfig,
  MagiConfig,
  PermissionConfig,
  PermissionRuleConfig,
  ResolvedAgents,
  ResolvedRepository,
  ResolvedReviewer,
  ResolvedTriageCategory,
  ResolvedTriageAgent,
  TriageLabelRuleConfig,
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
const DEFAULT_TRIAGE_CATEGORIES: ResolvedTriageCategory[] = [
  {
    description: "Something is broken or behaves incorrectly.",
    id: "bug",
    labels: ["bug"],
    types: ["Bug"],
  },
  {
    description: "Maintenance, refactoring, chores, or planned work.",
    id: "task",
    labels: ["task"],
    types: ["Task"],
  },
  {
    description: "New or improved user-facing capability.",
    id: "feature",
    labels: ["enhancement"],
    types: ["Feature"],
  },
]

export const DEFAULT_TRIAGE_LABEL_RULES: TriageLabelRuleConfig[] = [
  { remove: ["triage"], when: { disposition: "accepted" } },
  {
    add: ["duplicate"],
    remove: ["triage"],
    when: { disposition: "duplicate" },
  },
  {
    add: ["duplicate"],
    remove: ["triage"],
    when: { disposition: "already_handled" },
  },
  {
    add: ["wontfix"],
    remove: ["triage"],
    when: { disposition: "rejected" },
  },
  {
    add: ["invalid"],
    remove: ["triage"],
    when: { disposition: "invalid" },
  },
  { add: ["question"], when: { disposition: "needs_category" } },
  { add: ["question"], when: { disposition: "needs_acceptance" } },
]

export function reviewerKey(reviewer: { id?: string }, index: number): string {
  return reviewer.id ?? `reviewer-${index + 1}`
}

export function triageAgentKey(agent: { id?: string }, index: number): string {
  return agent.id ?? `voter-${index + 1}`
}

export function validateReviewerId(id: string): boolean {
  return ID_PATTERN.test(id)
}

function normalizedModel(model: unknown): string {
  if (typeof model !== "string") {
    throw new Error("model must be normalized before resolving agents")
  }

  return model
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

export function resolveTriageAgentPermission(
  agents: AgentsConfig,
  agent: { permissions?: PermissionConfig },
): PermissionConfig {
  return mergePermissions(
    mergePermissions(DEFAULT_REVIEWER_PERMISSION, agents.permissions),
    agent.permissions,
  )
}

export function resolveTriageCreatorPermission(
  agents: AgentsConfig,
  creator: { permissions?: PermissionConfig },
): PermissionConfig {
  return mergePermissions(
    mergePermissions(DEFAULT_EDITOR_PERMISSION, agents.permissions),
    creator.permissions,
  )
}

export function resolveAgents(config: MagiConfig): ResolvedAgents {
  const agents = config.agents ?? {}
  const editor = config.merge?.editor
  const creator = config.triage?.creator

  return {
    editor: editor
      ? {
          ...editor,
          model: normalizedModel(editor.model),
          permission: resolveEditorPermission(agents, editor),
        }
      : undefined,
    reviewers: (config.review?.reviewers ?? []).map<ResolvedReviewer>(
      (reviewer, index) => ({
        ...reviewer,
        key: reviewerKey(reviewer, index),
        index,
        model: normalizedModel(reviewer.model),
        permission: resolveReviewerPermission(agents, reviewer),
      }),
    ),
    triage: (config.triage?.voters ?? []).map<ResolvedTriageAgent>(
      (agent, index) => ({
        ...agent,
        key: triageAgentKey(agent, index),
        index,
        model: normalizedModel(agent.model),
        permission: resolveTriageAgentPermission(agents, agent),
      }),
    ),
    triageCreator: creator
      ? {
          ...creator,
          account: creator.account ?? "",
          model: normalizedModel(creator.model),
          permission: resolveTriageCreatorPermission(agents, creator),
        }
      : undefined,
  }
}

function resolveTriageCategories(config: MagiConfig): ResolvedTriageCategory[] {
  return (config.triage?.categories ?? DEFAULT_TRIAGE_CATEGORIES).map(
    (category) => ({
      description: category.description,
      id: category.id ?? "",
      labels: category.labels ?? [],
      types: category.types ?? [],
    }),
  )
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
    triage: {
      automation: {
        close: config.triage?.automation?.close ?? false,
        create: config.triage?.automation?.create ?? false,
        label: config.triage?.automation?.label ?? DEFAULT_TRIAGE_LABEL_RULES,
        merge: config.triage?.automation?.merge ?? false,
        review: config.triage?.automation?.review ?? false,
      },
      categories: resolveTriageCategories(config),
      concurrency: {
        runs: config.triage?.concurrency?.runs ?? 3,
      },
      output: config.triage?.output,
      prompts: config.triage?.prompts ?? {},
      reporter: config.triage?.reporter,
      safety: {
        allowAuthors: config.triage?.safety?.allowAuthors ?? [],
        allowMentionActors: config.triage?.safety?.allowMentionActors ?? [],
        allowMentionRoles: config.triage?.safety?.allowMentionRoles ?? [
          "AUTHOR",
          "OWNER",
          "MEMBER",
          "COLLABORATOR",
        ],
        blockedLabels: config.triage?.safety?.blockedLabels ?? [],
        requiredLabels: config.triage?.safety?.requiredLabels ?? ["triage"],
      },
      signals: config.triage?.signals ?? [],
      worktree: config.triage?.worktree,
    },
  }
}
