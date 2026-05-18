import type { PullRequestSafetyMeta } from "../github/commands"
import type { Exec, ResolvedRepository } from "../types"
import picomatch from "picomatch"
import { fetchPullRequestSafetyMeta } from "../github/commands"

export interface SafetyGateResult {
  meta: PullRequestSafetyMeta
  ok: boolean
  reasons: string[]
}

export function evaluateSafetyGate(
  repository: ResolvedRepository,
  meta: PullRequestSafetyMeta,
): SafetyGateResult {
  const reasons: string[] = []
  const labels = new Set(meta.labels)
  const missingLabels = repository.safety.requiredLabels.filter(
    (label) => !labels.has(label),
  )

  if (missingLabels.length) {
    reasons.push(`Missing required labels: ${missingLabels.join(", ")}`)
  }

  if (
    repository.safety.allowAuthors.length &&
    !repository.safety.allowAuthors.includes(meta.author)
  ) {
    reasons.push(`PR author is not allowed: ${meta.author || "unknown"}`)
  }

  if (
    repository.safety.maxChangedFiles != null &&
    meta.changedFiles > repository.safety.maxChangedFiles
  ) {
    reasons.push(
      `Changed files exceed safety limit: ${meta.changedFiles} > ${repository.safety.maxChangedFiles}`,
    )
  }

  if (repository.safety.blockedPaths.length) {
    const isBlocked = picomatch(repository.safety.blockedPaths, { dot: true })
    const blocked = meta.files.filter((file) => isBlocked(file))

    if (blocked.length) {
      reasons.push(`Blocked paths changed: ${blocked.slice(0, 10).join(", ")}`)
    }
  }

  return { meta, ok: reasons.length === 0, reasons }
}

export function hasSafetyGate(repository: ResolvedRepository): boolean {
  return Boolean(
    repository.safety.requiredLabels.length ||
    repository.safety.blockedPaths.length ||
    repository.safety.allowAuthors.length ||
    repository.safety.maxChangedFiles != null,
  )
}

export async function checkSafetyGate(input: {
  exec: Exec
  pr: number
  repository: ResolvedRepository
}): Promise<SafetyGateResult> {
  const meta = await fetchPullRequestSafetyMeta(
    input.exec,
    input.repository,
    input.pr,
  )

  return evaluateSafetyGate(input.repository, meta)
}

export function formatSafetyGateReport(result: SafetyGateResult): string {
  if (result.ok) return "- **Safety**: Passed"

  return [
    "- **Safety**: Blocked",
    ...result.reasons.map((reason) => `  - ${reason}`),
  ].join("\n")
}
