export type InlineCommentTargets = ReadonlyMap<string, ReadonlySet<number>>

export interface InlineCommentFindingTarget {
  line: number
  path: string
  startLine?: number
}

function parseDiffPath(value: string): string | undefined {
  if (value === "/dev/null") return undefined

  let path = value
  if (path.startsWith('"') && path.endsWith('"')) {
    try {
      path = JSON.parse(path) as string
    } catch {
      path = path.slice(1, -1)
    }
  }

  return path.startsWith("b/") ? path.slice(2) : path
}

function addTargetLine(
  targets: Map<string, Set<number>>,
  path: string,
  line: number,
): void {
  const lines = targets.get(path) ?? new Set<number>()

  lines.add(line)
  targets.set(path, lines)
}

export function parseRightSideDiffTargets(diff: string): InlineCommentTargets {
  const targets = new Map<string, Set<number>>()
  let currentPath: string | undefined
  let rightLine: number | undefined

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      currentPath = parseDiffPath(line.slice(4))
      rightLine = undefined
      continue
    }

    if (line.startsWith("@@ ")) {
      const match = line.match(/\+(\d+)(?:,\d+)?/)

      rightLine = match ? Number(match[1]) : undefined
      continue
    }

    if (!currentPath || rightLine == null) continue

    if (line.startsWith("+") || line.startsWith(" ")) {
      addTargetLine(targets, currentPath, rightLine)
      rightLine += 1
      continue
    }

    if (line.startsWith("-")) continue
  }

  return targets
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
}

export function validateInlineCommentTargets(
  findings: readonly InlineCommentFindingTarget[],
  targets: InlineCommentTargets,
  label = "findings",
): void {
  for (const [index, finding] of findings.entries()) {
    const name = `${label}[${index}]`

    assertPositiveInteger(finding.line, `${name}.line`)
    if (finding.startLine != null) {
      assertPositiveInteger(finding.startLine, `${name}.startLine`)
      if (finding.startLine > finding.line) {
        throw new Error(`${name}.startLine must be before or equal to line`)
      }
    }

    const lines = targets.get(finding.path)

    if (!lines) {
      throw new Error(
        `${name} targets ${finding.path}:${finding.line}, but path is not in the PR diff`,
      )
    }

    const startLine = finding.startLine ?? finding.line
    for (let line = startLine; line <= finding.line; line += 1) {
      if (!lines.has(line)) {
        throw new Error(
          `${name} targets ${finding.path}:${line}, but line is not in a right-side PR diff hunk`,
        )
      }
    }
  }
}
