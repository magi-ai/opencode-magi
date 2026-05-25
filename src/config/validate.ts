import type {
  EditorConfig,
  Exec,
  MagiConfig,
  ModelOptions,
  PermissionConfig,
  ReviewerConfig,
  TriageAgentConfig,
  TriageAutomationConfig,
  TriageCategoryConfig,
  TriageConcurrencyConfig,
  TriageCreatorConfig,
  TriageSafetyConfig,
} from "../types"
import { Ajv2020 } from "ajv/dist/2020"
import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import schema from "../../schema.json" with { type: "json" }
import {
  resolveAgents,
  reviewerKey,
  triageAgentKey,
  validateReviewerId,
} from "./resolve"

export type ModelCatalog = Record<string, readonly string[]>

export interface ValidationOptions {
  checkAuth?: boolean
  directory?: string
  exec?: Exec
  modelCatalog?: ModelCatalog
  requireModelCatalog?: boolean
  requireEditor?: boolean
  requireGithub?: boolean
  requireReview?: boolean
  requireTriage?: boolean
  requireWorktreeConfig?: boolean
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
const TRIAGE_CATEGORY_ID_PATTERN = /^[A-Za-z0-9_-]+$/
const RESERVED_TRIAGE_CATEGORY_IDS = new Set(["ASK", "none"])
const CONFIG_KEYS = new Set([
  "$schema",
  "agents",
  "clear",
  "github",
  "language",
  "merge",
  "output",
  "review",
  "triage",
])
const AGENTS_KEYS = new Set(["permissions"])
const REVIEWER_KEYS = new Set([
  "account",
  "id",
  "model",
  "permissions",
  "persona",
])
const EDITOR_KEYS = new Set([
  "account",
  "author",
  "model",
  "permissions",
  "persona",
])
const TRIAGE_AGENT_KEYS = new Set([
  "account",
  "id",
  "model",
  "permissions",
  "persona",
])
const TRIAGE_CREATOR_KEYS = new Set([
  "account",
  "author",
  "model",
  "permissions",
  "persona",
])
const AUTHOR_KEYS = new Set(["email", "name"])
const GITHUB_KEYS = new Set(["apiRetryAttempts", "host", "owner", "repo"])
const REVIEW_KEYS = new Set([
  "automation",
  "checks",
  "concurrency",
  "merge",
  "output",
  "prompts",
  "reviewers",
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
const TRIAGE_KEYS = new Set([
  "automation",
  "categories",
  "concurrency",
  "creator",
  "output",
  "prompts",
  "reporter",
  "safety",
  "voters",
  "worktree",
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
const TRIAGE_AUTOMATION_KEYS = new Set([
  "clear",
  "close",
  "create",
  "merge",
  "review",
])
const TRIAGE_CATEGORY_KEYS = new Set(["description", "id", "labels", "types"])
const TRIAGE_CONCURRENCY_KEYS = new Set(["runs"])
const TRIAGE_SAFETY_KEYS = new Set([
  "allowAuthors",
  "allowMentionActors",
  "allowMentionRoles",
  "blockedLabels",
  "requiredLabels",
])
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
const TRIAGE_PROMPT_KEYS = new Set([
  "acceptance",
  "category",
  "commentClassification",
  "create",
  "createGuidelines",
  "duplicate",
  "existingPr",
  "reconsider",
])
const MODEL_CANDIDATE_KEYS = new Set(["id", "options"])

type AgentRefUse = Record<string, unknown> & { ref?: unknown }
type ModelTarget = { model?: unknown; options?: unknown }

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

function expandAgentRefUse(
  value: unknown,
  path: string,
  refs: Record<string, unknown> | undefined,
  refsInvalid: boolean,
  errors: string[],
): unknown {
  if (!isPlainObject(value) || !Object.hasOwn(value, "ref")) return value

  const use = { ...(value as AgentRefUse) }
  const ref = use.ref
  delete use.ref

  if (typeof ref !== "string") {
    errors.push(`${path}.ref must be a string`)
    return use
  }

  if (refsInvalid) {
    errors.push(`agents.refs must be an object to resolve ${path}.ref`)
    return use
  }

  const preset = refs?.[ref]
  if (preset == null) {
    errors.push(`${path}.ref references unknown agents.refs preset: ${ref}`)
    return use
  }

  if (!isPlainObject(preset)) {
    errors.push(
      `agents.refs.${ref} must be an object when referenced by ${path}.ref`,
    )
    return use
  }

  const presetFields = { ...(preset as AgentRefUse) }
  delete presetFields.ref

  return { ...presetFields, ...use }
}

function expandAgentRefs(config: MagiConfig, errors: string[]): void {
  if (!config || typeof config !== "object") return

  const magiConfig = config as MagiConfig
  const agents = magiConfig.agents
  const refsValue = isPlainObject(agents) ? agents.refs : undefined
  const refsInvalid = refsValue != null && !isPlainObject(refsValue)
  const refs = isPlainObject(refsValue) ? refsValue : undefined

  if (Array.isArray(magiConfig.review?.reviewers)) {
    magiConfig.review.reviewers = magiConfig.review.reviewers.map(
      (agent, index) =>
        expandAgentRefUse(
          agent,
          `review.reviewers[${index}]`,
          refs,
          refsInvalid,
          errors,
        ),
    ) as ReviewerConfig[]
  }

  if (isPlainObject(magiConfig.merge?.editor)) {
    magiConfig.merge.editor = expandAgentRefUse(
      magiConfig.merge.editor,
      "merge.editor",
      refs,
      refsInvalid,
      errors,
    ) as EditorConfig
  }

  if (Array.isArray(magiConfig.triage?.voters)) {
    magiConfig.triage.voters = magiConfig.triage.voters.map((agent, index) =>
      expandAgentRefUse(
        agent,
        `triage.voters[${index}]`,
        refs,
        refsInvalid,
        errors,
      ),
    ) as TriageAgentConfig[]
  }

  if (isPlainObject(magiConfig.triage?.creator)) {
    magiConfig.triage.creator = expandAgentRefUse(
      magiConfig.triage.creator,
      "triage.creator",
      refs,
      refsInvalid,
      errors,
    ) as TriageCreatorConfig
  }

  if (isPlainObject(magiConfig.agents)) delete magiConfig.agents.refs
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

function modelValidationError(
  model: string,
  path: string,
  catalog?: ModelCatalog,
): string | undefined {
  const slash = model.indexOf("/")

  if (slash <= 0 || slash === model.length - 1)
    return `${path} must be a full OpenCode model ID in provider/model form`

  if (!catalog) return undefined

  const providerId = model.slice(0, slash)
  const modelId = model.slice(slash + 1)
  const models = catalog[providerId]

  if (!models) return `${path} uses unknown OpenCode provider: ${providerId}`

  if (!models.includes(modelId))
    return `${path} uses unknown OpenCode model: ${model}`

  return undefined
}

function validateModelId(
  model: string,
  path: string,
  errors: string[],
  catalog?: ModelCatalog,
): boolean {
  const error = modelValidationError(model, path, catalog)

  if (error) {
    errors.push(error)
    return false
  }

  return true
}

function readModelCandidate(
  value: unknown,
  path: string,
  errors: string[],
): { id: string; options?: ModelOptions } | undefined {
  if (typeof value === "string") return { id: value }

  if (!isPlainObject(value)) {
    errors.push(`${path} must be a string or an object`)
    return undefined
  }

  validateKnownKeys(value, path, MODEL_CANDIDATE_KEYS, errors)

  if (typeof value.id !== "string") {
    errors.push(`${path}.id must be a string`)
    return undefined
  }

  if (value.options != null && !isPlainObject(value.options)) {
    errors.push(`${path}.options must be an object`)
    return undefined
  }

  return { id: value.id, options: value.options as ModelOptions | undefined }
}

function validateAndNormalizeModel(
  target: ModelTarget,
  path: string,
  errors: string[],
  catalog?: ModelCatalog,
): void {
  const model = target.model

  if (typeof model === "string") {
    validateModelId(model, path, errors, catalog)
    return
  }

  if (!Array.isArray(model)) {
    if (model != null) errors.push(`${path} must be a string or an array`)
    return
  }

  if (!model.length) {
    errors.push(`${path} must contain at least one model candidate`)
    return
  }

  if (!catalog) {
    errors.push(`${path} requires an OpenCode model catalog`)
    return
  }

  const candidateErrors: string[] = []

  for (const [index, value] of model.entries()) {
    const candidatePath = `${path}[${index}]`
    const candidate = readModelCandidate(value, candidatePath, errors)
    if (!candidate) continue

    const idPath = isPlainObject(value) ? `${candidatePath}.id` : candidatePath
    const error = modelValidationError(candidate.id, idPath, catalog)

    if (!error) {
      target.model = candidate.id
      if (candidate.options) target.options = candidate.options
      else delete target.options
      return
    }

    candidateErrors.push(error)
  }

  errors.push(
    `${path} must contain at least one usable OpenCode model candidate${
      candidateErrors.length ? ` (${candidateErrors.join("; ")})` : ""
    }`,
  )
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
    validateAndNormalizeModel(
      reviewer as ModelTarget,
      `${path}[${index}].model`,
      errors,
      catalog,
    )
    if (!reviewer.account) errors.push(`${path}[${index}].account is required`)
    validateString(reviewer.account, `${path}[${index}].account`, errors)
    validateString(reviewer.persona, `${path}[${index}].persona`, errors)
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

function validateTriageAgentList(
  voters: TriageAgentConfig[] | undefined,
  path: string,
  errors: string[],
  catalog?: ModelCatalog,
): void {
  if (voters == null) return
  if (!Array.isArray(voters)) {
    errors.push(`${path} must be an array`)
    return
  }

  if (voters.length < 3) errors.push(`${path} must contain at least 3 voters`)
  if (voters.length % 2 === 0)
    errors.push(`${path} must contain an odd number of voters`)

  voters.forEach((agent, index) => {
    if (!agent || typeof agent !== "object") {
      errors.push(`${path}[${index}] must be an object`)
      return
    }

    validateKnownKeys(agent, `${path}[${index}]`, TRIAGE_AGENT_KEYS, errors)
    if (!agent.model) errors.push(`${path}[${index}].model is required`)
    validateAndNormalizeModel(
      agent as ModelTarget,
      `${path}[${index}].model`,
      errors,
      catalog,
    )
    if (!agent.account) errors.push(`${path}[${index}].account is required`)
    validateString(agent.account, `${path}[${index}].account`, errors)
    validateString(agent.persona, `${path}[${index}].persona`, errors)
    validatePermissionConfig(
      agent.permissions,
      `${path}[${index}].permissions`,
      errors,
    )

    if (agent.id) {
      if (!validateReviewerId(agent.id)) {
        errors.push(
          `${path}[${index}].id may contain only letters, numbers, underscores, and hyphens`,
        )
      }
      if (RESERVED_REVIEWER_KEYS.has(agent.id)) {
        errors.push(`${path}[${index}].id is reserved: ${agent.id}`)
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

function validateResolvedTriageAgents(
  agents: { account: string; key: string }[],
  path: string,
  errors: string[],
): void {
  const keys = new Set<string>()
  const accounts = new Set<string>()

  for (const agent of agents) {
    if (keys.has(agent.key))
      errors.push(`${path} has duplicate agent key: ${agent.key}`)
    keys.add(agent.key)

    if (accounts.has(agent.account))
      errors.push(`${path} has duplicate agent account: ${agent.account}`)
    accounts.add(agent.account)
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
  validateAndNormalizeModel(
    editor as ModelTarget,
    `${path}.model`,
    errors,
    catalog,
  )
  validateString(editor.account, `${path}.account`, errors)
  validateString(editor.persona, `${path}.persona`, errors)
  if (!editor.account) errors.push(`${path}.account is required`)
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

function validateTriageCreator(
  creator: TriageCreatorConfig | undefined,
  path: string,
  errors: string[],
  catalog?: ModelCatalog,
): void {
  if (!creator) return
  if (!isPlainObject(creator)) {
    errors.push(`${path} must be an object`)
    return
  }

  validateKnownKeys(creator, path, TRIAGE_CREATOR_KEYS, errors)
  if (!creator.model) errors.push(`${path}.model is required`)
  validateString(creator.account, `${path}.account`, errors)
  validateAndNormalizeModel(
    creator as ModelTarget,
    `${path}.model`,
    errors,
    catalog,
  )
  validateString(creator.persona, `${path}.persona`, errors)
  validatePermissionConfig(creator.permissions, `${path}.permissions`, errors)

  const author = creator.author
  if (!author || !isPlainObject(author)) {
    if (author != null) errors.push(`${path}.author must be an object`)
    errors.push(`${path}.author.name is required`)
    errors.push(`${path}.author.email is required`)
    return
  }

  validateKnownKeys(author, `${path}.author`, AUTHOR_KEYS, errors)
  if (!author.name) errors.push(`${path}.author.name is required`)
  validateString(author.name, `${path}.author.name`, errors)
  if (!author.email) errors.push(`${path}.author.email is required`)
  validateString(author.email, `${path}.author.email`, errors)
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

function validateTriageCategories(
  categories: unknown,
  path: string,
  errors: string[],
): void {
  if (categories == null) return
  if (!Array.isArray(categories)) {
    errors.push(`${path} must be an array`)
    return
  }

  const ids = new Set<string>()
  categories.forEach((item, index) => {
    const itemPath = `${path}[${index}]`
    if (!isPlainObject(item)) {
      errors.push(`${itemPath} must be an object`)
      return
    }

    const category = item as TriageCategoryConfig
    validateKnownKeys(category, itemPath, TRIAGE_CATEGORY_KEYS, errors)
    if (!category.id) {
      errors.push(`${itemPath}.id is required`)
    } else if (typeof category.id !== "string") {
      errors.push(`${itemPath}.id must be a string`)
    } else if (!TRIAGE_CATEGORY_ID_PATTERN.test(category.id)) {
      errors.push(`${itemPath}.id must match /^[A-Za-z0-9_-]+$/`)
    } else if (RESERVED_TRIAGE_CATEGORY_IDS.has(category.id)) {
      errors.push(`${itemPath}.id is reserved: ${category.id}`)
    } else if (ids.has(category.id)) {
      errors.push(`${itemPath}.id must be unique`)
    } else {
      ids.add(category.id)
    }
    validateStringArray(category.labels, `${itemPath}.labels`, errors)
    validateStringArray(category.types, `${itemPath}.types`, errors)
    validateString(category.description, `${itemPath}.description`, errors)
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

function validateTriage(
  config: MagiConfig,
  errors: string[],
  options: ValidationOptions,
): void {
  const triage = config.triage
  if (!triage) return
  if (!isPlainObject(triage)) {
    errors.push("triage must be an object")
    return
  }

  validateKnownKeys(triage, "triage", TRIAGE_KEYS, errors)
  const automation = triage.automation as TriageAutomationConfig | undefined
  const concurrency = triage.concurrency as TriageConcurrencyConfig | undefined
  const creator = triage.creator as TriageCreatorConfig | undefined
  const reporter =
    typeof triage.reporter === "string" ? triage.reporter : undefined
  const safety = triage.safety as TriageSafetyConfig | undefined

  if (!triage.voters) errors.push("triage.voters is required")
  validateTriageAgentList(
    triage.voters as TriageAgentConfig[] | undefined,
    "triage.voters",
    errors,
    options.modelCatalog,
  )
  if (Array.isArray(triage.voters)) {
    const resolvedTriageAgents = triage.voters.map((agent, index) => ({
      account:
        agent && typeof agent === "object" && typeof agent.account === "string"
          ? agent.account
          : "",
      key:
        agent && typeof agent === "object" ? triageAgentKey(agent, index) : "",
    }))
    validateResolvedTriageAgents(
      resolvedTriageAgents,
      "triage.resolvedAgents",
      errors,
    )
    if (
      reporter != null &&
      !resolvedTriageAgents.some((agent) => agent.key === reporter)
    ) {
      errors.push(`triage.reporter must match a triage voter key: ${reporter}`)
    }
  }
  validateString(triage.reporter, "triage.reporter", errors)
  validateTriageCreator(creator, "triage.creator", errors, options.modelCatalog)
  if (automation?.create && !creator)
    errors.push(
      "triage.creator is required when triage.automation.create is true",
    )
  if (automation?.create && creator && !creator.account)
    errors.push(
      "triage.creator.account is required when triage.automation.create is true",
    )

  if (automation != null && !isPlainObject(automation)) {
    errors.push("triage.automation must be an object")
  }
  validateKnownKeys(
    automation,
    "triage.automation",
    TRIAGE_AUTOMATION_KEYS,
    errors,
  )
  validateBoolean(automation?.close, "triage.automation.close", errors)
  validateBoolean(automation?.create, "triage.automation.create", errors)
  validateBoolean(automation?.merge, "triage.automation.merge", errors)
  validateBoolean(automation?.review, "triage.automation.review", errors)
  validateStringArray(automation?.clear, "triage.automation.clear", errors)
  if (automation?.review && !automation.create) {
    errors.push(
      "triage.automation.review requires triage.automation.create to be true",
    )
  }
  if (automation?.merge && !automation.create) {
    errors.push(
      "triage.automation.merge requires triage.automation.create to be true",
    )
  }

  validateKnownKeys(
    concurrency,
    "triage.concurrency",
    TRIAGE_CONCURRENCY_KEYS,
    errors,
  )
  if (
    concurrency?.runs != null &&
    (typeof concurrency.runs !== "number" ||
      !Number.isInteger(concurrency.runs) ||
      concurrency.runs < 1)
  ) {
    errors.push("triage.concurrency.runs must be a positive integer")
  }

  validateTriageCategories(triage.categories, "triage.categories", errors)
  validateKnownKeys(safety, "triage.safety", TRIAGE_SAFETY_KEYS, errors)
  validateStringArray(
    safety?.allowAuthors,
    "triage.safety.allowAuthors",
    errors,
  )
  validateStringArray(
    safety?.allowMentionActors,
    "triage.safety.allowMentionActors",
    errors,
  )
  validateStringArray(
    safety?.allowMentionRoles,
    "triage.safety.allowMentionRoles",
    errors,
  )
  validateStringArray(
    safety?.blockedLabels,
    "triage.safety.blockedLabels",
    errors,
  )
  validateStringArray(
    safety?.requiredLabels,
    "triage.safety.requiredLabels",
    errors,
  )
  validateString(triage.output, "triage.output", errors)
  validateString(triage.worktree, "triage.worktree", errors)
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
  validatePromptObject(
    config.triage?.prompts,
    "triage.prompts",
    TRIAGE_PROMPT_KEYS,
    errors,
  )

  const promptEntries = [
    ...Object.entries(config.review?.prompts ?? {}).map(
      ([key, value]) => [`review.prompts.${key}`, value] as const,
    ),
    ...Object.entries(config.merge?.prompts ?? {}).map(
      ([key, value]) => [`merge.prompts.${key}`, value] as const,
    ),
    ...Object.entries(config.triage?.prompts ?? {}).map(
      ([key, value]) => [`triage.prompts.${key}`, value] as const,
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
  for (const agent of agents.triage ?? []) accounts.add(agent.account)
  if (agents.editor) accounts.add(agents.editor.account)
  if (agents.triageCreator?.account) accounts.add(agents.triageCreator.account)

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

async function validateWorktreeConfig(
  config: MagiConfig,
  exec: Exec | undefined,
  options: ValidationOptions,
  errors: string[],
): Promise<void> {
  const checkEditor = Boolean(
    config.merge?.editor &&
    (options.requireEditor || options.requireWorktreeConfig),
  )
  const checkTriageCreator = Boolean(
    config.triage?.automation?.create &&
    config.triage?.creator &&
    (options.requireTriage || options.requireWorktreeConfig),
  )

  if (!checkEditor && !checkTriageCreator) return
  if (!exec) return

  const error =
    "git config extensions.worktreeConfig must be true when editor or triage PR creator is configured"

  try {
    const value = (
      await exec("git config --bool --get extensions.worktreeConfig")
    )
      .trim()
      .toLowerCase()

    if (value !== "true") errors.push(error)
  } catch {
    errors.push(error)
  }
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

  await Promise.all(
    (agents.triage ?? []).map(async (agent) => {
      try {
        const permissions = await fetchPermissions(config, exec, agent.account)

        if (!permissions.pull) {
          errors.push(
            `GitHub account cannot read repository for issue triage: ${agent.account}`,
          )
        }
      } catch (error) {
        warnings.push(
          `Could not validate repository permissions for GitHub account: ${agent.account} (${(error as Error).message})`,
        )
      }
    }),
  )

  if (agents.triageCreator?.account) {
    try {
      const permissions = await fetchPermissions(
        config,
        exec,
        agents.triageCreator.account,
      )

      if (!permissions.push) {
        errors.push(
          `GitHub account cannot push to repository for triage PR creation: ${agents.triageCreator.account}`,
        )
      }
    } catch (error) {
      warnings.push(
        `Could not validate repository permissions for GitHub account: ${agents.triageCreator.account} (${(error as Error).message})`,
      )
    }
  }

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

  if (options.requireModelCatalog && !options.modelCatalog) {
    errors.push("OpenCode model catalog could not be loaded")
  }

  expandAgentRefs(config, errors)

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

  if ((options.requireReview ?? true) && !config.review) {
    errors.push("review is required")
  } else if (config.review) {
    if (!isPlainObject(config.review)) {
      errors.push("review must be an object")
    } else {
      validateKnownKeys(config.review, "review", REVIEW_KEYS, errors)
    }
    if (!config.review.reviewers) errors.push("review.reviewers is required")
    validateReviewerList(
      config.review.reviewers as ReviewerConfig[] | undefined,
      "review.reviewers",
      errors,
      options.modelCatalog,
    )
    if (Array.isArray(config.review.reviewers)) {
      validateResolvedReviewers(
        config.review.reviewers.map((reviewer, index) => ({
          account:
            reviewer &&
            typeof reviewer === "object" &&
            typeof reviewer.account === "string"
              ? reviewer.account
              : "",
          key:
            reviewer && typeof reviewer === "object"
              ? reviewerKey(reviewer, index)
              : "",
        })),
        "review.resolvedReviewers",
        errors,
      )
    }
  }

  if (options.requireTriage && !config.triage) {
    errors.push("triage is required")
  }

  validateMerge(config, errors, options)
  validateReviewMerge(config, errors)
  validateAutomation(config, errors)
  validateClear(config, errors)
  validateChecks(config, errors)
  validateConcurrency(config, errors)
  validateSafety(config, errors)
  validateTriage(config, errors, options)
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
  await validateWorktreeConfig(config, options.exec, options, errors)

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
