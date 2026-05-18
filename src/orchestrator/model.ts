import { repairPrompt } from "../prompts/contracts"
import type {
  ModelOptions,
  OpenCodePermissionRule,
  PermissionConfig,
} from "../types"
import { throwIfAborted } from "./abort"

export interface ModelClient {
  permission?: {
    reply(input: {
      requestID: string
      reply: "always" | "once" | "reject"
    }): Promise<unknown>
  }
  question?: {
    reject(input: { requestID: string }): Promise<unknown>
    reply(input: { answers: string[]; requestID: string }): Promise<unknown>
  }
  session: {
    create(input: {
      body: { permission?: OpenCodePermissionRule[]; title: string }
    }): Promise<unknown>
    abort?(input: { path: { id: string } }): Promise<unknown>
    delete?(input: { path: { id: string } }): Promise<unknown>
    promptAsync?(input: {
      body: Record<string, unknown>
      path: { id: string }
    }): Promise<unknown>
    prompt(input: {
      body: Record<string, unknown>
      path: { id: string }
    }): Promise<unknown>
  }
}

const OPENCODE_PERMISSION_NAMES = [
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "task",
  "external_directory",
  "todowrite",
  "question",
  "webfetch",
  "websearch",
  "repo_clone",
  "repo_overview",
  "lsp",
  "doom_loop",
  "skill",
]

function formatError(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === "string") return value

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function toOpenCodePermissionRules(
  permission?: PermissionConfig,
): OpenCodePermissionRule[] | undefined {
  if (!permission) return undefined

  if (typeof permission === "string") {
    return OPENCODE_PERMISSION_NAMES.map((name) => ({
      action: permission,
      pattern: "*",
      permission: name,
    }))
  }

  const rules: OpenCodePermissionRule[] = []

  for (const [name, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      rules.push({ action: value, pattern: "*", permission: name })
      continue
    }

    for (const [pattern, action] of Object.entries(value)) {
      rules.push({ action, pattern, permission: name })
    }
  }

  return rules
}

export interface ModelRunResult<T> {
  raw: string
  sessionId: string
  value: T
}

export interface ModelRunProgress {
  attempt?: number
  options?: ModelOptions
  raw?: string
  runAttempt?: number
  sessionId: string
  type: "repair" | "response" | "session_created"
}

function modelBody(model: string): Record<string, string> | string {
  const [providerID, ...modelParts] = model.split("/")

  if (!providerID || !modelParts.length) return model

  return { modelID: modelParts.join("/"), providerID }
}

function extractSessionId(result: unknown): string {
  const data = result as {
    data?: { id?: string }
    error?: unknown
    id?: string
    response?: { status?: number; statusText?: string }
  }

  if (data.error) {
    const status = data.response?.status
      ? ` (${data.response.status}${data.response.statusText ? ` ${data.response.statusText}` : ""})`
      : ""

    throw new Error(
      `OpenCode session.create failed${status}: ${formatError(data.error)}`,
    )
  }

  const id = data.data?.id ?? data.id

  if (!id)
    throw new Error("OpenCode session.create did not return a session id")

  return id
}

function extractText(result: unknown, allowEmpty = false): string {
  const data = result as {
    data?: {
      info?: { text?: string }
      parts?: Array<{ text?: string; type?: string }>
    }
    info?: { text?: string }
    parts?: Array<{ text?: string; type?: string }>
  }
  const parts = data.data?.parts ?? data.parts
  const text =
    data.data?.info?.text ??
    data.info?.text ??
    parts
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .filter((value): value is string => value != null)
      .join("\n")

  if (text == null || (!allowEmpty && !text))
    throw new Error("OpenCode session.prompt did not return text output")

  return text
}

export async function createModelSession(input: {
  client: ModelClient
  permission?: PermissionConfig
  title: string
}): Promise<string> {
  return extractSessionId(
    await input.client.session.create({
      body: {
        permission: toOpenCodePermissionRules(input.permission),
        title: input.title,
      },
    }),
  )
}

export async function promptModelText(input: {
  allowEmpty?: boolean
  client: ModelClient
  model: string
  prompt: string
  sessionId: string
  signal?: AbortSignal
}): Promise<string> {
  throwIfAborted(input.signal)

  const result = await input.client.session.prompt({
    body: {
      model: modelBody(input.model),
      parts: [{ type: "text", text: input.prompt }],
    },
    path: { id: input.sessionId },
  })

  throwIfAborted(input.signal)

  return extractText(result, input.allowEmpty)
}

async function sendPrompt(
  client: ModelClient,
  sessionId: string,
  model: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  return promptModelText({ client, model, prompt, sessionId, signal })
}

export async function runModelText(input: {
  allowEmpty?: boolean
  client: ModelClient
  initialPrompt?: string
  model: string
  onProgress?: (progress: ModelRunProgress) => void | Promise<void>
  options?: ModelOptions
  permission?: PermissionConfig
  prompt: string
  signal?: AbortSignal
  title: string
}): Promise<{ raw: string; sessionId: string }> {
  throwIfAborted(input.signal)

  const sessionId = await createModelSession({
    client: input.client,
    permission: input.permission,
    title: input.title,
  })

  await input.onProgress?.({
    options: input.options,
    runAttempt: 1,
    sessionId,
    type: "session_created",
  })

  if (input.initialPrompt?.trim()) {
    await promptModelText({
      client: input.client,
      model: input.model,
      prompt: input.initialPrompt,
      sessionId,
      signal: input.signal,
    })
  }

  const raw = await promptModelText({
    allowEmpty: input.allowEmpty,
    client: input.client,
    model: input.model,
    prompt: input.prompt,
    sessionId,
    signal: input.signal,
  })

  await input.onProgress?.({ raw, runAttempt: 1, sessionId, type: "response" })

  return { raw, sessionId }
}

export async function runModelWithRepair<T>(input: {
  client: ModelClient
  model: string
  onProgress?: (progress: ModelRunProgress) => void | Promise<void>
  options?: ModelOptions
  parse: (text: string) => T
  permission?: PermissionConfig
  prompt: string
  repairAttempts: number
  runAttempts?: number
  schemaName: string
  signal?: AbortSignal
  sessionId?: string
  title: string
}): Promise<ModelRunResult<T>> {
  throwIfAborted(input.signal)

  const runAttempts = Math.max(1, Math.floor(input.runAttempts ?? 2))
  let lastError: unknown

  for (let runAttempt = 1; runAttempt <= runAttempts; runAttempt += 1) {
    throwIfAborted(input.signal)

    const sessionId =
      runAttempt === 1 && input.sessionId
        ? input.sessionId
        : extractSessionId(
            await input.client.session.create({
              body: {
                permission: toOpenCodePermissionRules(input.permission),
                title: input.title,
              },
            }),
          )

    await input.onProgress?.({
      options: input.options,
      runAttempt,
      sessionId,
      type: "session_created",
    })

    try {
      let raw = await sendPrompt(
        input.client,
        sessionId,
        input.model,
        input.prompt,
        input.signal,
      )

      await input.onProgress?.({ raw, runAttempt, sessionId, type: "response" })

      for (let attempt = 0; attempt <= input.repairAttempts; attempt += 1) {
        throwIfAborted(input.signal)

        try {
          return { raw, sessionId, value: input.parse(raw) }
        } catch (error) {
          lastError = error
          if (attempt === input.repairAttempts) throw error
          await input.onProgress?.({
            attempt: attempt + 1,
            runAttempt,
            sessionId,
            type: "repair",
          })
          raw = await sendPrompt(
            input.client,
            sessionId,
            input.model,
            repairPrompt(input.schemaName),
            input.signal,
          )
          await input.onProgress?.({
            raw,
            runAttempt,
            sessionId,
            type: "response",
          })
        }
      }
    } catch (error) {
      lastError = error
      if (runAttempt === runAttempts) throw error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("unreachable model retry state")
}
