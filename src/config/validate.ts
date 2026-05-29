import type { Config } from "."
import type { Exec } from "@/utils"
import { Ajv2020 } from "ajv/dist/2020"
import { createExecWithGitHubApiRetry } from "@/github"
import { command, filterEmpty } from "@/utils"
import schema from "../../schema.json" with { type: "json" }

function required(
  required: boolean,
  value: unknown,
  name: string,
): string | undefined {
  return required && !value ? `${name} is required` : undefined
}

const ajv = new Ajv2020({ allErrors: true, strict: false })
const validateSchema = ajv.compile(schema)

function schemaErrors(config: Config.Root): string[] {
  if (validateSchema(config)) return []

  return (validateSchema.errors ?? []).map(
    (e) =>
      `schema ${e.instancePath || "config"}: ${e.message ?? "invalid value"}`,
  )
}

function requiredErrors(
  config: Config.Root,
  {
    creator = false,
    editor = false,
    github = true,
    reviewers = false,
    voters = false,
  }: ConfigValidationOptions["require"] = {},
): string[] {
  const errors = [
    required(github, config.github.owner, "github.owner"),
    required(github, config.github.repo, "github.repo"),
    required(reviewers, config.review.reviewers, "review.reviewers"),
    ...(config.review.reviewers ?? []).map((reviewer, index) =>
      required(reviewers, reviewer.model, `review.reviewers[${index}].model`),
    ),
    required(editor, config.merge.editor, "merge.editor"),
    required(editor, config.merge.editor.model, "merge.editor.model"),
    required(editor, config.merge.editor.author, "merge.editor.author"),
    required(voters, config.triage.voters, "triage.voters"),
    ...(config.triage.voters ?? []).map((voter, index) =>
      required(voters, voter.model, `triage.voters[${index}].model`),
    ),
    required(creator, config.triage.creator, "triage.creator"),
    required(creator, config.triage.creator.model, "triage.creator.model"),
    required(creator, config.triage.creator.author, "triage.creator.author"),
  ]

  if (config.mode === "single") {
    errors.push(required(true, config.account, "account"))
  } else {
    errors.push(
      ...(config.review.reviewers ?? []).map((reviewer, index) =>
        required(
          reviewers,
          reviewer.account,
          `review.reviewers[${index}].account`,
        ),
      ),
    )
    errors.push(
      required(editor, config.merge.editor.account, "merge.editor.account"),
    )
    errors.push(
      ...(config.triage.voters ?? []).map((voter, index) =>
        required(voters, voter.account, `triage.voters[${index}].account`),
      ),
    )
    errors.push(
      required(
        creator,
        config.triage.creator.account,
        "triage.creator.account",
      ),
    )
  }

  return filterEmpty(errors)
}

function duplicateErrors(
  values: string[],
  message: (value: string) => string,
): string[] {
  const seen = new Set<string>()

  return values.flatMap((value) => {
    if (seen.has(value)) return [message(value)]

    seen.add(value)

    return []
  })
}

function agentGroupErrors(
  agents: Config.Reviewer[] | Config.Voter[] | undefined,
  path: string,
): string[] {
  if (!agents) return []

  return [
    ...(agents.length % 2 === 0
      ? [`${path} must contain an odd number of agents`]
      : []),
    ...duplicateErrors(
      agents.map(({ id }) => id),
      (value) => `${path} has duplicate id: ${value}`,
    ),
  ]
}

function groupErrors(config: Config.Root): string[] {
  return [
    ...agentGroupErrors(config.review.reviewers, "review.reviewers"),
    ...agentGroupErrors(config.triage.voters, "triage.voters"),
  ]
}

async function authError(
  config: Config.Root,
  exec: NonNullable<ConfigValidationOptions["exec"]>,
  account: string,
): Promise<string | undefined> {
  try {
    await createExecWithGitHubApiRetry(
      exec,
      config.github.retryApiAttempts,
    )(command("gh", "auth", "token", "--user", JSON.stringify(account)))

    return undefined
  } catch {
    return `GitHub account is not authenticated: ${account}`
  }
}

async function authErrors(config: Config.Root, exec: Exec): Promise<string[]> {
  if (config.mode === "single") {
    return filterEmpty([await authError(config, exec, config.account!)])
  } else {
    const accounts = {
      ...Object.fromEntries(
        config.review.reviewers!.map(({ account }, index) => [
          account!,
          `review.reviewers[${index}]`,
        ]),
      ),
      [config.merge.editor.account!]: "merge.editor",
      ...Object.fromEntries(
        config.triage.voters!.map(({ account }, index) => [
          account!,
          `triage.voters[${index}]`,
        ]),
      ),
      [config.triage.creator.account!]: "triage.creator",
    }

    return filterEmpty([
      ...duplicateErrors(
        Object.keys(accounts),
        (value) => `${accounts[value]} has duplicate account: ${value}`,
      ),
      ...(await Promise.all(
        Object.keys(accounts).map((account) =>
          authError(config, exec, account),
        ),
      )),
    ])
  }
}

export interface ConfigValidationOptions {
  exec?: Exec
  require?: {
    creator?: boolean
    editor?: boolean
    github?: boolean
    reviewers?: boolean
    voters?: boolean
  }
}

export async function validateConfig(
  config: Config.Root,
  { exec, require }: ConfigValidationOptions = {},
) {
  const errors = [
    ...schemaErrors(config),
    ...requiredErrors(config, require),
    ...groupErrors(config),
  ]

  if (!errors.length && exec) errors.push(...(await authErrors(config, exec)))

  return errors
}
