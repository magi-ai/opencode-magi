import type {
  Finding,
  FindingValidationOutput,
  RereviewOutput,
  ReviewOutput,
} from "../types"
import { majorityThreshold } from "./majority"

type ValidatedOutput = RereviewOutput | ReviewOutput

export interface FindingValidationTarget {
  finding: Finding
  findingIndex: number
  reviewer: string
}

export interface FindingValidationSummary {
  discarded: FindingValidationTarget[]
  kept: FindingValidationTarget[]
}

function validationFindings(output: ValidatedOutput): Finding[] {
  if ("findings" in output) return output.findings

  return output.newFindings.map((finding) => ({
    fix: "Please address this before merging.",
    issue: finding.body,
    line: finding.line,
    path: finding.path,
    startLine: finding.startLine,
  }))
}

export function reviewFindingTargets(
  outputs: Record<string, ValidatedOutput>,
): FindingValidationTarget[] {
  return Object.entries(outputs).flatMap(([reviewer, output]) => {
    if (output.verdict !== "CHANGES_REQUESTED") return []

    return validationFindings(output).map((finding, findingIndex) => ({
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
}
export function applyFindingValidation(input: {
  outputs: Record<string, ValidatedOutput>
  reviewerKeys: string[]
  validations: Record<string, FindingValidationOutput>
}): {
  outputs: Record<string, ValidatedOutput>
  summary: FindingValidationSummary
}
export function applyFindingValidation(input: {
  outputs: Record<string, ValidatedOutput>
  reviewerKeys: string[]
  validations: Record<string, FindingValidationOutput>
}): {
  outputs: Record<string, ValidatedOutput>
  summary: FindingValidationSummary
} {
  const threshold = majorityThreshold(input.reviewerKeys.length)
  const kept: FindingValidationTarget[] = []
  const discarded: FindingValidationTarget[] = []
  const next: Record<string, ValidatedOutput> = {}

  for (const [reviewer, output] of Object.entries(input.outputs)) {
    if (output.verdict !== "CHANGES_REQUESTED") {
      next[reviewer] = output
      continue
    }

    const keptIndexes = new Set<number>()
    const findings = validationFindings(output)

    findings.forEach((finding, findingIndex) => {
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
        keptIndexes.add(findingIndex)
        return
      }

      discarded.push(target)
    })

    if ("findings" in output) {
      const keptFindings = output.findings.filter((_finding, index) =>
        keptIndexes.has(index),
      )

      next[reviewer] = keptFindings.length
        ? { ...output, findings: keptFindings }
        : { findings: [], verdict: "MERGE" }
      continue
    }

    const newFindings = output.newFindings.filter((_finding, index) =>
      keptIndexes.has(index),
    )
    next[reviewer] =
      newFindings.length || output.followUps.length
        ? { ...output, newFindings }
        : { ...output, newFindings, verdict: "MERGE" }
  }

  return { outputs: next, summary: { discarded, kept } }
}
