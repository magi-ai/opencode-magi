import type { Finding, FindingValidationOutput, ReviewOutput } from "../types"
import { majorityThreshold } from "./majority"

export interface FindingValidationTarget {
  finding: Finding
  findingIndex: number
  reviewer: string
}

export interface FindingValidationSummary {
  discarded: FindingValidationTarget[]
  kept: FindingValidationTarget[]
}

export function reviewFindingTargets(
  outputs: Record<string, ReviewOutput>,
): FindingValidationTarget[] {
  return Object.entries(outputs).flatMap(([reviewer, output]) => {
    if (output.verdict !== "CHANGES_REQUESTED") return []

    return output.findings.map((finding, findingIndex) => ({
      finding,
      findingIndex,
      reviewer,
    }))
  })
}

export function validateFindingVotes(input: {
  output: FindingValidationOutput
  targets: FindingValidationTarget[]
  validator: string
}): void {
  const expected = input.targets.filter(
    (target) => target.reviewer !== input.validator,
  )
  const expectedKeys = new Set(
    expected.map((target) => `${target.reviewer}:${target.findingIndex}`),
  )
  const seen = new Set<string>()

  for (const vote of input.output.votes) {
    if (vote.reviewer === input.validator) {
      throw new Error(`${input.validator} must not vote on its own findings`)
    }

    const key = `${vote.reviewer}:${vote.findingIndex}`

    if (!expectedKeys.has(key))
      throw new Error(`unexpected finding vote: ${key}`)
    if (seen.has(key)) throw new Error(`duplicate finding vote: ${key}`)
    seen.add(key)
  }

  for (const target of expected) {
    const key = `${target.reviewer}:${target.findingIndex}`

    if (!seen.has(key)) throw new Error(`missing finding vote: ${key}`)
  }
}

export function applyFindingValidation(input: {
  outputs: Record<string, ReviewOutput>
  reviewerKeys: string[]
  validations: Record<string, FindingValidationOutput>
}): {
  outputs: Record<string, ReviewOutput>
  summary: FindingValidationSummary
} {
  const threshold = majorityThreshold(input.reviewerKeys.length)
  const kept: FindingValidationTarget[] = []
  const discarded: FindingValidationTarget[] = []
  const next: Record<string, ReviewOutput> = {}

  for (const [reviewer, output] of Object.entries(input.outputs)) {
    if (output.verdict !== "CHANGES_REQUESTED") {
      next[reviewer] = output
      continue
    }

    const findings = output.findings.filter((finding, findingIndex) => {
      let agrees = 1

      for (const validator of input.reviewerKeys) {
        if (validator === reviewer) continue

        const vote = input.validations[validator]?.votes.find(
          (item) =>
            item.reviewer === reviewer && item.findingIndex === findingIndex,
        )

        if (vote?.vote === "AGREE") agrees += 1
      }

      const target = { finding, findingIndex, reviewer }

      if (agrees >= threshold) {
        kept.push(target)
        return true
      }

      discarded.push(target)
      return false
    })

    next[reviewer] =
      findings.length || output.requirementFindings.length
        ? { ...output, findings }
        : { findings: [], requirementFindings: [], verdict: "MERGE" }
  }

  return { outputs: next, summary: { discarded, kept } }
}
