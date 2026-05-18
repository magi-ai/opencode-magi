import type {
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
  "automation",
  "clear",
  "checks",
  "concurrency",
  "github",
  "language",
  "merge",
  "output",
  "prompts",
  "safety",
  "worktree",
])
const AGENTS_KEYS = new Set(["editor", "permissions", "reviewers"])
const REVIEWER_KEYS = new Set([
  "account",
  "id",
  "model",
  "options",
  "permission",
  "persona",
])
const EDITOR_KEYS = new Set([
  "account",
  "author",
  "model",
  "options",
  "permission",
  "persona",
])
const AUTHOR_KEYS = new Set(["email", "name"])
const GITHUB_KEYS = new Set(["apiRetryAttempts", "host", "owner", "repo"])
const MERGE_KEYS = new Set([
  "approvalPolicy",
  "auto",
  "deleteBranch",
  "maxThreadResolutionCycles",
  "mergeQueue",
  "method",
])
const CHECKS_KEYS = new Set([
  "exclude",
  "retryFailedJobs",
  "waitAfterEdit",
  "waitBeforeReview",
])
const AUTOMATION_KEYS = new Set(["close", "merge"])
const CLEAR_KEYS = new Set(["branch", "output", "session", "worktree"])
const CONCURRENCY_KEYS = new Set(["reviewers", "runs"])
const OUTPUT_KEYS = new Set(["dirs", "repairAttempts"])
const OUTPUT_DIR_KEYS = new Set(["pr"])
const WORKTREE_KEYS = new Set(["dir"])
const SAFETY_KEYS = new Set([
  "allowAuthors",
  "blockedPaths",
  "maxChangedFiles",
  "requiredLabels",
])
const PROMPT_KEYS = new Set([
  "ciClassification",
  "ciClassificationAfterEdit",
  "closeReconsideration",
  "edit",
  "editGuidelines",
  "findingValidation",
  "report",
  "rereview",
  "rereviewCloseReconsideration",
  "review",
  "reviewGuidelines",
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
      reviewer.permission,
      `${path}[${index}].permission`,
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

function validateMerge(
  config: MagiConfig,
  errors: string[],
  options: ValidationOptions,
): void {
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

  if (config.merge != null && !isPlainObject(config.merge)) {
    errors.push("merge must be an object")
  }

  validateKnownKeys(config.merge, "merge", MERGE_KEYS, errors)
  validateBoolean(config.merge?.auto, "merge.auto", errors)
  validateBoolean(config.merge?.deleteBranch, "merge.deleteBranch", errors)
  validateBoolean(config.merge?.mergeQueue, "merge.mergeQueue", errors)

  if (
    config.github?.apiRetryAttempts != null &&
    (typeof config.github.apiRetryAttempts !== "number" ||
      !Number.isInteger(config.github.apiRetryAttempts) ||
      config.github.apiRetryAttempts < 0)
  ) {
    errors.push("github.apiRetryAttempts must be a non-negative integer")
  }

  if (
    config.merge?.method != null &&
    (typeof config.merge.method !== "string" ||
      !["merge", "rebase", "squash"].includes(config.merge.method))
  ) {
    errors.push("merge.method must be merge, squash, or rebase")
  }

  if (
    config.merge?.approvalPolicy != null &&
    (typeof config.merge.approvalPolicy !== "string" ||
      !["majority", "unanimous"].includes(config.merge.approvalPolicy))
  ) {
    errors.push("merge.approvalPolicy must be majority or unanimous")
  }

  if (
    config.merge?.maxThreadResolutionCycles != null &&
    (typeof config.merge.maxThreadResolutionCycles !== "number" ||
      !Number.isInteger(config.merge.maxThreadResolutionCycles) ||
      config.merge.maxThreadResolutionCycles < 0)
  ) {
    errors.push(
      "merge.maxThreadResolutionCycles must be a non-negative integer",
    )
  }
}

function validateConcurrency(config: MagiConfig, errors: string[]): void {
  if (config.concurrency != null && !isPlainObject(config.concurrency)) {
    errors.push("concurrency must be an object")
  }

  validateKnownKeys(config.concurrency, "concurrency", CONCURRENCY_KEYS, errors)

  if (config.concurrency?.runs != null) {
    if (
      typeof config.concurrency.runs !== "number" ||
      !Number.isInteger(config.concurrency.runs) ||
      config.concurrency.runs < 1
    ) {
      errors.push("concurrency.runs must be a positive integer")
    }
  }

  if (config.concurrency?.reviewers != null) {
    if (
      typeof config.concurrency.reviewers !== "number" ||
      !Number.isInteger(config.concurrency.reviewers) ||
      config.concurrency.reviewers < 1
    ) {
      errors.push("concurrency.reviewers must be a positive integer")
    }
  }
}

function validateAutomation(config: MagiConfig, errors: string[]): void {
  if (config.automation != null && !isPlainObject(config.automation)) {
    errors.push("automation must be an object")
  }

  validateKnownKeys(config.automation, "automation", AUTOMATION_KEYS, errors)

  if (
    config.automation?.merge != null &&
    typeof config.automation.merge !== "boolean"
  ) {
    errors.push("automation.merge must be a boolean")
  }

  if (
    config.automation?.close != null &&
    typeof config.automation.close !== "boolean"
  ) {
    errors.push("automation.close must be a boolean")
  }
}

function validateClear(config: MagiConfig, errors: string[]): void {
  validateBooleanObject(config.clear, "clear", CLEAR_KEYS, errors)
}

function validateChecks(config: MagiConfig, errors: string[]): void {
  if (config.checks != null && !isPlainObject(config.checks)) {
    errors.push("checks must be an object")
  }

  validateKnownKeys(config.checks, "checks", CHECKS_KEYS, errors)

  if (config.checks?.exclude != null) {
    if (!Array.isArray(config.checks.exclude)) {
      errors.push("checks.exclude must be an array")
    } else {
      config.checks.exclude.forEach((item, index) => {
        if (typeof item !== "string")
          errors.push(`checks.exclude[${index}] must be a string`)
      })
    }
  }

  if (
    config.checks?.waitBeforeReview != null &&
    typeof config.checks.waitBeforeReview !== "boolean"
  ) {
    errors.push("checks.waitBeforeReview must be a boolean")
  }

  if (
    config.checks?.waitAfterEdit != null &&
    typeof config.checks.waitAfterEdit !== "boolean"
  ) {
    errors.push("checks.waitAfterEdit must be a boolean")
  }

  if (
    config.checks?.retryFailedJobs != null &&
    (typeof config.checks.retryFailedJobs !== "number" ||
      !Number.isInteger(config.checks.retryFailedJobs) ||
      config.checks.retryFailedJobs < 0)
  ) {
    errors.push("checks.retryFailedJobs must be a non-negative integer")
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
  if (config.safety != null && !isPlainObject(config.safety)) {
    errors.push("safety must be an object")
  }

  validateKnownKeys(config.safety, "safety", SAFETY_KEYS, errors)
  validateStringArray(
    config.safety?.allowAuthors,
    "safety.allowAuthors",
    errors,
  )
  validateStringArray(
    config.safety?.blockedPaths,
    "safety.blockedPaths",
    errors,
  )
  validateStringArray(
    config.safety?.requiredLabels,
    "safety.requiredLabels",
    errors,
  )

  if (
    config.safety?.maxChangedFiles != null &&
    (typeof config.safety.maxChangedFiles !== "number" ||
      !Number.isInteger(config.safety.maxChangedFiles) ||
      config.safety.maxChangedFiles < 0)
  ) {
    errors.push("safety.maxChangedFiles must be a non-negative integer")
  }
}

async function validatePrompts(
  config: MagiConfig,
  errors: string[],
  directory?: string,
): Promise<void> {
  if (config.prompts == null) return
  if (!isPlainObject(config.prompts)) {
    errors.push("prompts must be an object")
    return
  }

  validateKnownKeys(config.prompts, "prompts", PROMPT_KEYS, errors)

  await Promise.all(
    Object.entries(config.prompts).map(async ([key, value]) => {
      if (typeof value !== "string") {
        errors.push(`prompts.${key} must be a string`)
        return
      }

      if (!directory) return

      const fullPath = promptPath(directory, value)

      try {
        await access(fullPath, constants.R_OK)
      } catch {
        errors.push(`prompts.${key} file is not readable: ${value}`)
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
  const agents = resolveAgents(config.agents)

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
    `GH_TOKEN=${JSON.stringify(token)} gh api${ghHostOption(config)} repos/${config.github?.owner}/${config.github?.repo} --jq .permissions`,
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

  const agents = resolveAgents(config.agents)

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

  if (!config.agents) {
    errors.push("agents is required")
  } else {
    if (!isPlainObject(config.agents)) {
      errors.push("agents must be an object")
    } else {
      validateKnownKeys(config.agents, "agents", AGENTS_KEYS, errors)
    }
    validatePermissionConfig(
      config.agents.permissions,
      "agents.permissions",
      errors,
    )
    if (!config.agents.reviewers) errors.push("agents.reviewers is required")
    validateReviewerList(
      config.agents.reviewers,
      "agents.reviewers",
      errors,
      options.modelCatalog,
    )
    if (options.requireEditor && !config.agents.editor)
      errors.push("agents.editor is required")
    if (config.agents.editor) {
      if (!config.agents.editor.model)
        errors.push("agents.editor.model is required")
      validateKnownKeys(
        config.agents.editor,
        "agents.editor",
        EDITOR_KEYS,
        errors,
      )
      validateString(config.agents.editor.model, "agents.editor.model", errors)
      validateString(
        config.agents.editor.account,
        "agents.editor.account",
        errors,
      )
      validateString(
        config.agents.editor.persona,
        "agents.editor.persona",
        errors,
      )
      validateModel(
        config.agents.editor.model,
        "agents.editor.model",
        errors,
        options.modelCatalog,
      )
      if (!config.agents.editor.account)
        errors.push("agents.editor.account is required")
      if (
        config.agents.editor.options != null &&
        !isPlainObject(config.agents.editor.options)
      ) {
        errors.push("agents.editor.options must be an object")
      }
      validatePermissionConfig(
        config.agents.editor.permission,
        "agents.editor.permission",
        errors,
      )
      const author = config.agents.editor.author
      if (!author || !isPlainObject(author)) {
        if (author != null)
          errors.push("agents.editor.author must be an object")
        errors.push("agents.editor.author.name is required")
        errors.push("agents.editor.author.email is required")
      } else {
        validateKnownKeys(author, "agents.editor.author", AUTHOR_KEYS, errors)
        if (!author.name) {
          errors.push("agents.editor.author.name is required")
        } else if (typeof author.name !== "string") {
          errors.push("agents.editor.author.name must be a string")
        }

        if (!author.email) {
          errors.push("agents.editor.author.email is required")
        } else if (typeof author.email !== "string") {
          errors.push("agents.editor.author.email must be a string")
        }
      }
    }
    if (Array.isArray(config.agents.reviewers)) {
      validateResolvedReviewers(
        resolveAgents(config.agents).reviewers,
        "agents.resolvedReviewers",
        errors,
      )
    }
  }

  validateMerge(config, errors, options)
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

  if (config.output?.dirs != null) {
    if (!isPlainObject(config.output.dirs)) {
      errors.push("output.dirs must be an object")
    } else {
      validateKnownKeys(
        config.output.dirs,
        "output.dirs",
        OUTPUT_DIR_KEYS,
        errors,
      )
      const dirs = config.output.dirs as Record<string, unknown>
      for (const key of OUTPUT_DIR_KEYS) {
        const value = dirs[key]
        if (value != null && typeof value !== "string") {
          errors.push(`output.dirs.${key} must be a string`)
        }
      }
    }
  }

  if (config.worktree != null && !isPlainObject(config.worktree)) {
    errors.push("worktree must be an object")
  }

  validateKnownKeys(config.worktree, "worktree", WORKTREE_KEYS, errors)

  if (config.worktree?.dir != null && typeof config.worktree.dir !== "string") {
    errors.push("worktree.dir must be a string")
  }

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
