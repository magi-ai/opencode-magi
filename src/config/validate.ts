import type {
  EditorConfig,
  Exec,
  MagiConfig,
  PermissionConfig,
  ReviewerConfig,
} from "../types"
import { Ajv2020 } from "ajv/dist/2020"
import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import schema from "../../schema.json" with { type: "json" }
import { resolveAgents, validateReviewerId } from "./resolve"

export type ModelCatalog = Record<string, readonly string[]>

export interface ValidationOptions {
  checkAuth?: boolean
  directory?: string
  exec?: Exec
  modelCatalog?: ModelCatalog
  requireEditor?: boolean
  requireGithub?: boolean
}

export interface ValidationResult {
  errors: string[]
  ok: boolean
  warnings: string[]
}

const RESERVED_REVIEWER_KEYS = new Set(["editor", "orchestrator", "system"])
const PERMISSION_ACTIONS = new Set(["allow", "ask", "deny"])
const AJV = new Ajv2020({ allErrors: true, strict: false })
const validateSchema = AJV.compile(schema)
const CONFIG_KEYS = new Set([
  "$schema",
  "agents",
  "clear",
  "github",
  "language",
  "merge",
  "output",
  "review",
])
const AGENTS_KEYS = new Set(["permissions"])
const REVIEWER_KEYS = new Set([
  "account",
  "id",
  "model",
  "options",
  "permissions",
  "persona",
])
const EDITOR_KEYS = new Set([
  "account",
  "author",
  "model",
  "options",
  "permissions",
  "persona",
])
const AUTHOR_KEYS = new Set(["email", "name"])
const GITHUB_KEYS = new Set(["apiRetryAttempts", "host", "owner", "repo"])
const REVIEW_KEYS = new Set([
  "agents",
  "automation",
  "checks",
  "concurrency",
  "merge",
  "output",
  "prompts",
  "safety",
  "worktree",
])
const MERGE_KEYS = new Set([
  "automation",
  "checks",
  "editor",
  "maxThreadResolutionCycles",
  "prompts",
])
const REVIEW_MERGE_KEYS = new Set([
  "approvalPolicy",
  "auto",
  "deleteBranch",
  "method",
  "queue",
])
const REVIEW_CHECKS_KEYS = new Set(["exclude", "retryFailedJobs", "wait"])
const MERGE_CHECKS_KEYS = new Set(["wait"])
const AUTOMATION_KEYS = new Set(["close", "merge"])
const CLEAR_KEYS = new Set(["branch", "output", "session", "worktree"])
const CONCURRENCY_KEYS = new Set(["reviewers", "runs"])
const OUTPUT_KEYS = new Set(["repairAttempts"])
const SAFETY_KEYS = new Set([
  "allowAuthors",
  "blockedPaths",
  "maxChangedFiles",
  "requiredLabels",
])
const REVIEW_PROMPT_KEYS = new Set([
  "ciClassification",
  "closeReconsideration",
  "findingValidation",
  "rereview",
  "review",
  "reviewGuidelines",
])
const MERGE_PROMPT_KEYS = new Set([
  "ciClassification",
  "edit",
  "editGuidelines",
])

function githubHost(config: MagiConfig): string {
  return config.github?.host ?? "github.com"
}

function ghHostOption(config: MagiConfig): string {
  const host = githubHost(config)

  return host === "github.com" ? "" : ` --hostname ${JSON.stringify(host)}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function validateKnownKeys(
  value: unknown,
  path: string,
  keys: Set<string>,
  errors: string[],
): void {
  if (!isPlainObject(value)) return

  for (const key of Object.keys(value)) {
    if (!keys.has(key)) errors.push(`${path}.${key} is not supported`)
  }
}

function validateJsonSchema(config: MagiConfig, errors: string[]): void {
  if (!validateSchema(config)) {
    for (const error of validateSchema.errors ?? []) {
      const path = error.instancePath || "config"
      errors.push(`schema ${path}: ${error.message ?? "invalid value"}`)
    }
  }
}

function validateString(value: unknown, path: string, errors: string[]): void {
  if (value != null && typeof value !== "string") {
    errors.push(`${path} must be a string`)
  }
}

function validateBoolean(value: unknown, path: string, errors: string[]): void {
  if (value != null && typeof value !== "boolean") {
    errors.push(`${path} must be a boolean`)
  }
}

function validateBooleanObject(
  value: unknown,
  path: string,
  keys: Set<string>,
  errors: string[],
): void {
  if (value != null && !isPlainObject(value)) {
    errors.push(`${path} must be an object`)
    return
  }

  validateKnownKeys(value, path, keys, errors)

  if (!isPlainObject(value)) return

  for (const key of keys) validateBoolean(value[key], `${path}.${key}`, errors)
}

function promptPath(directory: string, path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))

  return isAbsolute(path) ? path : join(directory, path)
}

function isPermissionAction(value: unknown): boolean {
  return typeof value === "string" && PERMISSION_ACTIONS.has(value)
}

function validatePermissionConfig(
  permission: PermissionConfig | undefined,
  path: string,
  errors: string[],
): void {
  if (permission == null) return
  if (isPermissionAction(permission)) return

  if (!isPlainObject(permission)) {
    errors.push(`${path} must be allow, ask, deny, or an object`)
    return
  }

  for (const [key, value] of Object.entries(permission)) {
    if (isPermissionAction(value)) continue
    if (!isPlainObject(value)) {
      errors.push(`${path}.${key} must be allow, ask, deny, or an object`)
      continue
    }

    for (const [pattern, action] of Object.entries(value)) {
      if (!isPermissionAction(action)) {
        errors.push(`${path}.${key}.${pattern} must be allow, ask, or deny`)
      }
    }
  }
}

function validateModel(
  model: string | undefined,
  path: string,
  errors: string[],
  catalog?: ModelCatalog,
): void {
  if (!model) return

  const slash = model.indexOf("/")

  if (slash <= 0 || slash === model.length - 1) {
    errors.push(
      `${path} must be a full OpenCode model ID in provider/model form`,
    )
    return
  }

  if (!catalog) return

  const providerId = model.slice(0, slash)
  const modelId = model.slice(slash + 1)
  const models = catalog[providerId]

  if (!models) {
    errors.push(`${path} uses unknown OpenCode provider: ${providerId}`)
    return
  }

  if (!models.includes(modelId)) {
    errors.push(`${path} uses unknown OpenCode model: ${model}`)
  }
}

function validateReviewerList(
  reviewers: ReviewerConfig[] | undefined,
  path: string,
  errors: string[],
  catalog?: ModelCatalog,
): void {
  if (reviewers == null) return
  if (!Array.isArray(reviewers)) {
    errors.push(`${path} must be an array`)
    return
  }

  if (reviewers.length < 3)
    errors.push(`${path} must contain at least 3 reviewers`)
  if (reviewers.length % 2 === 0)
    errors.push(`${path} must contain an odd number of reviewers`)

  reviewers.forEach((reviewer, index) => {
    if (!reviewer || typeof reviewer !== "object") {
      errors.push(`${path}[${index}] must be an object`)
      return
    }

    validateKnownKeys(reviewer, `${path}[${index}]`, REVIEWER_KEYS, errors)
    if (!reviewer.model) errors.push(`${path}[${index}].model is required`)
    validateString(reviewer.model, `${path}[${index}].model`, errors)
    validateModel(reviewer.model, `${path}[${index}].model`, errors, catalog)
    if (!reviewer.account) errors.push(`${path}[${index}].account is required`)
    validateString(reviewer.account, `${path}[${index}].account`, errors)
    validateString(reviewer.persona, `${path}[${index}].persona`, errors)
    if (reviewer.options != null && !isPlainObject(reviewer.options))
      errors.push(`${path}[${index}].options must be an object`)
    validatePermissionConfig(
      reviewer.permissions,
      `${path}[${index}].permissions`,
      errors,
    )

    if (reviewer.id) {
      if (!validateReviewerId(reviewer.id)) {
        errors.push(
          `${path}[${index}].id may contain only letters, numbers, underscores, and hyphens`,
        )
      }

      if (RESERVED_REVIEWER_KEYS.has(reviewer.id)) {
        errors.push(`${path}[${index}].id is reserved: ${reviewer.id}`)
      }
    }
  })
}

function validateResolvedReviewers(
  reviewers: { account: string; key: string }[],
  path: string,
  errors: string[],
): void {
  const keys = new Set<string>()
  const accounts = new Set<string>()

  for (const reviewer of reviewers) {
    if (keys.has(reviewer.key))
      errors.push(`${path} has duplicate reviewer key: ${reviewer.key}`)
    keys.add(reviewer.key)

    if (accounts.has(reviewer.account))
      errors.push(`${path} has duplicate reviewer account: ${reviewer.account}`)
    accounts.add(reviewer.account)
  }
}

function validateEditor(
  editor: EditorConfig | undefined,
  path: string,
  errors: string[],
  catalog?: ModelCatalog,
): void {
  if (!editor) return
  if (!isPlainObject(editor)) {
    errors.push(`${path} must be an object`)
    return
  }

  if (!editor.model) errors.push(`${path}.model is required`)
  validateKnownKeys(editor, path, EDITOR_KEYS, errors)
  validateString(editor.model, `${path}.model`, errors)
  validateString(editor.account, `${path}.account`, errors)
  validateString(editor.persona, `${path}.persona`, errors)
  validateModel(editor.model, `${path}.model`, errors, catalog)
  if (!editor.account) errors.push(`${path}.account is required`)
  if (editor.options != null && !isPlainObject(editor.options)) {
    errors.push(`${path}.options must be an object`)
  }
  validatePermissionConfig(editor.permissions, `${path}.permissions`, errors)
  const author = editor.author
  if (!author || !isPlainObject(author)) {
    if (author != null) errors.push(`${path}.author must be an object`)
    errors.push(`${path}.author.name is required`)
    errors.push(`${path}.author.email is required`)
  } else {
    validateKnownKeys(author, `${path}.author`, AUTHOR_KEYS, errors)
    if (!author.name) {
      errors.push(`${path}.author.name is required`)
    } else if (typeof author.name !== "string") {
      errors.push(`${path}.author.name must be a string`)
    }

    if (!author.email) {
      errors.push(`${path}.author.email is required`)
    } else if (typeof author.email !== "string") {
      errors.push(`${path}.author.email must be a string`)
    }
  }
}

function validateMerge(
  config: MagiConfig,
  errors: string[],
  options: ValidationOptions,
): void {
  const merge = config.merge

  if (options.requireGithub ?? true) {
    if (!config.github?.owner) errors.push("github.owner is required")
    if (!config.github?.repo) errors.push("github.repo is required")
  }

  validateKnownKeys(config.github, "github", GITHUB_KEYS, errors)
  validateString(config.github?.host, "github.host", errors)
  validateString(config.github?.owner, "github.owner", errors)
  validateString(config.github?.repo, "github.repo", errors)

  if (config.github != null && !isPlainObject(config.github)) {
    errors.push("github must be an object")
  }

  if (
    config.github?.apiRetryAttempts != null &&
    (typeof config.github.apiRetryAttempts !== "number" ||
      !Number.isInteger(config.github.apiRetryAttempts) ||
      config.github.apiRetryAttempts < 0)
  ) {
    errors.push("github.apiRetryAttempts must be a non-negative integer")
  }

  if (merge != null && !isPlainObject(merge)) {
    errors.push("merge must be an object")
  }

  validateKnownKeys(merge, "merge", MERGE_KEYS, errors)
  validateBooleanObject(
    merge?.automation,
    "merge.automation",
    AUTOMATION_KEYS,
    errors,
  )
  const checks = merge?.checks as { wait?: unknown } | undefined
  validateKnownKeys(checks, "merge.checks", MERGE_CHECKS_KEYS, errors)
  validateBoolean(checks?.wait, "merge.checks.wait", errors)
  validateEditor(
    merge?.editor as EditorConfig | undefined,
    "merge.editor",
    errors,
    options.modelCatalog,
  )

  if (
    merge?.maxThreadResolutionCycles != null &&
    (typeof merge.maxThreadResolutionCycles !== "number" ||
      !Number.isInteger(merge.maxThreadResolutionCycles) ||
      merge.maxThreadResolutionCycles < 0)
  ) {
    errors.push(
      "merge.maxThreadResolutionCycles must be a non-negative integer",
    )
  }

  if (options.requireEditor && !merge?.editor)
    errors.push("merge.editor is required")
}

function validateReviewMerge(config: MagiConfig, errors: string[]): void {
  const merge = config.review?.merge
  if (merge != null && !isPlainObject(merge)) {
    errors.push("review.merge must be an object")
  }

  validateKnownKeys(merge, "review.merge", REVIEW_MERGE_KEYS, errors)
  validateBoolean(merge?.auto, "review.merge.auto", errors)
  validateBoolean(merge?.deleteBranch, "review.merge.deleteBranch", errors)
  validateBoolean(merge?.queue, "review.merge.queue", errors)

  if (
    merge?.method != null &&
    (typeof merge.method !== "string" ||
      !["merge", "rebase", "squash"].includes(merge.method))
  ) {
    errors.push("review.merge.method must be merge, squash, or rebase")
  }

  if (
    merge?.approvalPolicy != null &&
    (typeof merge.approvalPolicy !== "string" ||
      !["majority", "unanimous"].includes(merge.approvalPolicy))
  ) {
    errors.push("review.merge.approvalPolicy must be majority or unanimous")
  }
}

function validateConcurrency(config: MagiConfig, errors: string[]): void {
  const concurrency = config.review?.concurrency
  if (concurrency != null && !isPlainObject(concurrency)) {
    errors.push("review.concurrency must be an object")
  }

  validateKnownKeys(concurrency, "review.concurrency", CONCURRENCY_KEYS, errors)

  if (concurrency?.runs != null) {
    if (
      typeof concurrency.runs !== "number" ||
      !Number.isInteger(concurrency.runs) ||
      concurrency.runs < 1
    ) {
      errors.push("review.concurrency.runs must be a positive integer")
    }
  }

  if (concurrency?.reviewers != null) {
    if (
      typeof concurrency.reviewers !== "number" ||
      !Number.isInteger(concurrency.reviewers) ||
      concurrency.reviewers < 1
    ) {
      errors.push("review.concurrency.reviewers must be a positive integer")
    }
  }
}

function validateAutomation(config: MagiConfig, errors: string[]): void {
  validateBooleanObject(
    config.review?.automation,
    "review.automation",
    AUTOMATION_KEYS,
    errors,
  )
}

function validateClear(config: MagiConfig, errors: string[]): void {
  validateBooleanObject(config.clear, "clear", CLEAR_KEYS, errors)
}

function validateChecks(config: MagiConfig, errors: string[]): void {
  const checks = config.review?.checks
  if (checks != null && !isPlainObject(checks)) {
    errors.push("review.checks must be an object")
  }

  validateKnownKeys(checks, "review.checks", REVIEW_CHECKS_KEYS, errors)

  if (checks?.exclude != null) {
    if (!Array.isArray(checks.exclude)) {
      errors.push("review.checks.exclude must be an array")
    } else {
      checks.exclude.forEach((item, index) => {
        if (typeof item !== "string")
          errors.push(`review.checks.exclude[${index}] must be a string`)
      })
    }
  }

  if (checks?.wait != null && typeof checks.wait !== "boolean") {
    errors.push("review.checks.wait must be a boolean")
  }

  if (
    checks?.retryFailedJobs != null &&
    (typeof checks.retryFailedJobs !== "number" ||
      !Number.isInteger(checks.retryFailedJobs) ||
      checks.retryFailedJobs < 0)
  ) {
    errors.push("review.checks.retryFailedJobs must be a non-negative integer")
  }
}

function validateStringArray(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (value == null) return
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`)
    return
  }

  value.forEach((item, index) => {
    if (typeof item !== "string")
      errors.push(`${path}[${index}] must be a string`)
  })
}

function validateSafety(config: MagiConfig, errors: string[]): void {
  const safety = config.review?.safety
  if (safety != null && !isPlainObject(safety)) {
    errors.push("review.safety must be an object")
  }

  validateKnownKeys(safety, "review.safety", SAFETY_KEYS, errors)
  validateStringArray(
    safety?.allowAuthors,
    "review.safety.allowAuthors",
    errors,
  )
  validateStringArray(
    safety?.blockedPaths,
    "review.safety.blockedPaths",
    errors,
  )
  validateStringArray(
    safety?.requiredLabels,
    "review.safety.requiredLabels",
    errors,
  )

  if (
    safety?.maxChangedFiles != null &&
    (typeof safety.maxChangedFiles !== "number" ||
      !Number.isInteger(safety.maxChangedFiles) ||
      safety.maxChangedFiles < 0)
  ) {
    errors.push("review.safety.maxChangedFiles must be a non-negative integer")
  }
}

function validatePromptObject(
  prompts: unknown,
  path: string,
  keys: Set<string>,
  errors: string[],
): void {
  if (prompts == null) return
  if (!isPlainObject(prompts)) {
    errors.push(`${path} must be an object`)
    return
  }

  validateKnownKeys(prompts, path, keys, errors)
  for (const [key, value] of Object.entries(prompts)) {
    if (typeof value !== "string")
      errors.push(`${path}.${key} must be a string`)
  }
}

async function validatePrompts(
  config: MagiConfig,
  errors: string[],
  directory?: string,
): Promise<void> {
  validatePromptObject(
    config.review?.prompts,
    "review.prompts",
    REVIEW_PROMPT_KEYS,
    errors,
  )
  validatePromptObject(
    config.merge?.prompts,
    "merge.prompts",
    MERGE_PROMPT_KEYS,
    errors,
  )

  const promptEntries = [
    ...Object.entries(config.review?.prompts ?? {}).map(
      ([key, value]) => [`review.prompts.${key}`, value] as const,
    ),
    ...Object.entries(config.merge?.prompts ?? {}).map(
      ([key, value]) => [`merge.prompts.${key}`, value] as const,
    ),
  ]

  await Promise.all(
    promptEntries.map(async ([path, value]) => {
      if (typeof value !== "string") return

      if (!directory) return

      const fullPath = promptPath(directory, value)

      try {
        await access(fullPath, constants.R_OK)
      } catch {
        errors.push(`${path} file is not readable: ${value}`)
      }
    }),
  )
}

async function validateAuth(
  config: MagiConfig,
  exec: Exec,
  errors: string[],
): Promise<void> {
  const accounts = new Set<string>()
  const agents = resolveAgents(config)

  for (const reviewer of agents.reviewers) accounts.add(reviewer.account)
  if (agents.editor) accounts.add(agents.editor.account)

  await Promise.all(
    [...accounts].filter(Boolean).map(async (account) => {
      try {
        await exec(
          `gh auth token${ghHostOption(config)} --user ${JSON.stringify(account)}`,
        )
      } catch {
        errors.push(`GitHub account is not authenticated: ${account}`)
      }
    }),
  )
}

async function fetchPermissions(
  config: MagiConfig,
  exec: Exec,
  account: string,
): Promise<{ pull?: boolean; push?: boolean }> {
  const token = (
    await exec(
      `gh auth token${ghHostOption(config)} --user ${JSON.stringify(account)}`,
    )
  ).trim()
  const raw = await exec(
    `gh api${ghHostOption(config)} repos/${config.github?.owner}/${config.github?.repo} --jq .permissions`,
    { env: { GH_TOKEN: token } },
  )

  return JSON.parse(raw) as { pull?: boolean; push?: boolean }
}

async function validateRepositoryPermissions(
  config: MagiConfig,
  exec: Exec,
  errors: string[],
  warnings: string[],
): Promise<void> {
  if (!config.github?.owner || !config.github.repo) return

  const agents = resolveAgents(config)

  await Promise.all(
    agents.reviewers.map(async (reviewer) => {
      try {
        const permissions = await fetchPermissions(
          config,
          exec,
          reviewer.account,
        )

        if (!permissions.pull) {
          errors.push(
            `GitHub account cannot read repository for PR review: ${reviewer.account}`,
          )
        }
      } catch (error) {
        warnings.push(
          `Could not validate repository permissions for GitHub account: ${reviewer.account} (${(error as Error).message})`,
        )
      }
    }),
  )

  if (!agents.editor) return

  try {
    const permissions = await fetchPermissions(
      config,
      exec,
      agents.editor.account,
    )

    if (!permissions.push) {
      errors.push(
        `GitHub account cannot push to repository for editor operations: ${agents.editor.account}`,
      )
    }
  } catch (error) {
    warnings.push(
      `Could not validate repository permissions for GitHub account: ${agents.editor.account} (${(error as Error).message})`,
    )
  }
}

export async function validateConfig(
  config: MagiConfig,
  options: ValidationOptions = {},
): Promise<ValidationResult> {
  const errors: string[] = []
  const warnings: string[] = []

  if (!config || typeof config !== "object")
    errors.push("config must be an object")

  if (config && typeof config === "object") validateJsonSchema(config, errors)

  validateKnownKeys(config, "config", CONFIG_KEYS, errors)
  validateString(config.$schema, "$schema", errors)
  validateString(config.language, "language", errors)

  if (config.agents != null && !isPlainObject(config.agents)) {
    errors.push("agents must be an object")
  } else {
    validateKnownKeys(config.agents, "agents", AGENTS_KEYS, errors)
    validatePermissionConfig(
      config.agents?.permissions as PermissionConfig | undefined,
      "agents.permissions",
      errors,
    )
  }

  if (!config.review) {
    errors.push("review is required")
  } else {
    if (!isPlainObject(config.review)) {
      errors.push("review must be an object")
    } else {
      validateKnownKeys(config.review, "review", REVIEW_KEYS, errors)
    }
    if (!config.review.agents) errors.push("review.agents is required")
    validateReviewerList(
      config.review.agents as ReviewerConfig[] | undefined,
      "review.agents",
      errors,
      options.modelCatalog,
    )
    if (Array.isArray(config.review.agents)) {
      validateResolvedReviewers(
        resolveAgents(config).reviewers,
        "review.resolvedAgents",
        errors,
      )
    }
  }

  validateMerge(config, errors, options)
  validateReviewMerge(config, errors)
  validateAutomation(config, errors)
  validateClear(config, errors)
  validateChecks(config, errors)
  validateConcurrency(config, errors)
  validateSafety(config, errors)
  await validatePrompts(config, errors, options.directory)

  if (config.output != null && !isPlainObject(config.output)) {
    errors.push("output must be an object")
  }

  validateKnownKeys(config.output, "output", OUTPUT_KEYS, errors)

  if (config.output?.repairAttempts != null) {
    if (
      typeof config.output.repairAttempts !== "number" ||
      !Number.isInteger(config.output.repairAttempts) ||
      config.output.repairAttempts < 0
    ) {
      errors.push("output.repairAttempts must be a non-negative integer")
    }
  }

  validateString(config.review?.output, "review.output", errors)
  validateString(config.review?.worktree, "review.worktree", errors)

  if (options.checkAuth && !errors.length) {
    if (!options.exec) {
      errors.push("validateConfig requires exec when checkAuth is true")
    } else {
      await validateAuth(config, options.exec, errors)
      if (!errors.length) {
        await validateRepositoryPermissions(
          config,
          options.exec,
          errors,
          warnings,
        )
      }
    }
  }

  return { errors, ok: errors.length === 0, warnings }
}
