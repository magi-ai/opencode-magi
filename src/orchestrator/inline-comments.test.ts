import { describe, expect, test } from "vitest"
import {
  parseRightSideDiffTargets,
  validateInlineCommentTargets,
} from "./inline-comments"

const diff = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -8,6 +8,7 @@ export function app() {
 contextBefore()
-oldCall()
+newCall()
 contextAfter()
 }
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const value = 1
+export const other = 2`

describe("inline comment targets", () => {
  test("accepts right-side lines inside diff hunks", () => {
    const targets = parseRightSideDiffTargets(diff)

    expect(() =>
      validateInlineCommentTargets(
        [
          { line: 10, path: "src/app.ts" },
          { line: 2, path: "src/new.ts", startLine: 1 },
        ],
        targets,
      ),
    ).not.toThrow()
  })

  test("skips file-level findings without line targets", () => {
    const targets = parseRightSideDiffTargets(diff)

    expect(() =>
      validateInlineCommentTargets(
        [{ path: "src/app.ts" }, { line: 10, path: "src/app.ts" }],
        targets,
      ),
    ).not.toThrow()
  })

  test("rejects startLine without a line target", () => {
    const targets = parseRightSideDiffTargets(diff)

    expect(() =>
      validateInlineCommentTargets(
        [{ path: "src/app.ts", startLine: 10 }],
        targets,
      ),
    ).toThrow("findings[0].startLine requires line")
  })

  test("rejects wildcard paths that are not concrete PR diff files", () => {
    const targets = parseRightSideDiffTargets(diff)

    expect(() =>
      validateInlineCommentTargets(
        [{ line: 1, path: ".changeset/*.md" }],
        targets,
      ),
    ).toThrow("path is not in the PR diff")
  })

  test("rejects changed files when the line is outside right-side hunks", () => {
    const targets = parseRightSideDiffTargets(diff)

    expect(() =>
      validateInlineCommentTargets(
        [{ line: 100, path: "src/app.ts" }],
        targets,
      ),
    ).toThrow("line is not in a right-side PR diff hunk")
  })

  test("rejects multi-line comments that span outside right-side hunks", () => {
    const targets = parseRightSideDiffTargets(diff)

    expect(() =>
      validateInlineCommentTargets(
        [{ line: 12, path: "src/app.ts", startLine: 10 }],
        targets,
        "newFindings",
      ),
    ).toThrow("newFindings[0] targets src/app.ts:12")
  })
})
