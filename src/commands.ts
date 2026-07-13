import type { Config } from "@opencode-ai/plugin"

export const commands: Config["command"] = {
  "magi:clear": {
    description: [
      "Clear inactive Magi runs, sessions, worktrees, and outputs",
    ].join("\n"),
    template: "Call the `magi_clear` tool.",
  },
  "magi:merge": {
    description: "Review and merge pull requests with Magi",
    template: ["Call the `magi_merge` tool.", "PR: $ARGUMENTS"].join("\n"),
  },
  "magi:review": {
    description: "Review pull requests with Magi",
    template: ["Call the `magi_review` tool.", "PR: $ARGUMENTS"].join("\n"),
  },
  "magi:triage": {
    description: "Triage issues with Magi",
    template: ["Call the `magi_triage` tool.", "Issue: $ARGUMENTS"].join("\n"),
  },
  "magi:validate": {
    description: "Validate Magi config",
    template: ["Call the `magi_validate` tool."].join("\n"),
  },
}
