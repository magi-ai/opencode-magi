export const MAGI_COMMANDS = {
  "magi:clear": {
    description: "Clear inactive Magi runs, sessions, worktrees, and outputs",
    template: "Call the `magi_clear` tool.",
  },
  "magi:cancel": {
    description: "Cancel a Magi background run",
    template: [`Call the \`magi_cancel\` tool.`, "Selector: $ARGUMENTS"].join(
      "\n",
    ),
  },
  "magi:merge": {
    description: "Review and merge pull requests with Magi",
    template: [`Call the \`magi_merge\` tool.`, "PR: $ARGUMENTS"].join("\n"),
  },
  "magi:triage": {
    description: "Triage GitHub issues with Magi",
    template: [`Call the \`magi_triage\` tool.`, "Issue: $ARGUMENTS"].join(
      "\n",
    ),
  },
  "magi:review": {
    description: "Review pull requests with Magi",
    template: [`Call the \`magi_review\` tool.`, "PR: $ARGUMENTS"].join("\n"),
  },
  "magi:output": {
    description: "Show Magi run output artifacts",
    template: [`Call the \`magi_output\` tool.`, "Selector: $ARGUMENTS"].join(
      "\n",
    ),
  },
  "magi:status": {
    description: "Show Magi background run status",
    template: [`Call the \`magi_status\` tool.`, "Selector: $ARGUMENTS"].join(
      "\n",
    ),
  },
  "magi:validate": {
    description: "Validate Magi config",
    template: "Call the `magi_validate` tool.",
  },
}
