import { join } from "node:path"
import { homedir } from "node:os"
import { Config } from "./config"
import commonPermissions from "./permissions/common.json" with { type: "json" }
import editPermissions from "./permissions/editor.json" with { type: "json" }

export const CONFIG_PATH = {
  GLOBAL: join(homedir(), ".config", "opencode", "magi.json"),
  PROJECT: join(".opencode", "magi.json"),
}
export const DEFAULT_CONFIG: Config.Root = {
  github: { host: "github.com", apiRetryAttempts: 3 },
  mode: "single",
  language: "en",
  agents: {
    permissions: commonPermissions as Config.Permissions,
  },
  output: {
    repairAttempts: 3,
  },
  review: {
    checks: {
      exclude: [],
      wait: true,
      retryFailedJobs: 3,
    },
    safety: {
      requiredLabels: [],
      blockedPaths: [],
      allowAuthors: [],
    },
    automation: {
      merge: true,
      close: false,
    },
    concurrency: {
      runs: 3,
      reviewers: 3,
    },
    merge: {
      approvalPolicy: "majority",
      method: "squash",
      auto: true,
      deleteBranch: true,
      queue: false,
    },
    output: ".magi/runs/pr",
    worktree: ".magi/worktrees/pr",
  },
  merge: {
    editor: {
      permissions: editPermissions as Config.Permissions,
    },
    checks: {
      wait: true,
    },
    automation: {
      merge: true,
      close: false,
      conflict: false,
    },
    maxThreadResolutionCycles: 5,
  },
  triage: {
    categories: [
      {
        description: "Something is broken or behaves incorrectly.",
        id: "bug",
        labels: ["bug"],
        types: ["Bug"],
      },
      {
        description: "Maintenance, refactoring, chores, or planned work.",
        id: "task",
        labels: ["task"],
        types: ["Task"],
      },
      {
        description: "New or improved user-facing capability.",
        id: "feature",
        labels: ["enhancement"],
        types: ["Feature"],
      },
    ],
    creator: {
      permissions: editPermissions as Config.Permissions,
    },
    automation: {
      create: false,
      merge: false,
      close: false,
      review: false,
      label: [
        { remove: ["triage"], when: { disposition: "accepted" } },
        {
          add: ["duplicate"],
          remove: ["triage"],
          when: { disposition: "duplicate" },
        },
        {
          add: ["duplicate"],
          remove: ["triage"],
          when: { disposition: "already_handled" },
        },
        {
          add: ["wontfix"],
          remove: ["triage"],
          when: { disposition: "rejected" },
        },
        {
          add: ["invalid"],
          remove: ["triage"],
          when: { disposition: "invalid" },
        },
        { add: ["question"], when: { disposition: "needs_category" } },
        { add: ["question"], when: { disposition: "needs_acceptance" } },
      ],
    },
    safety: {
      requiredLabels: ["triage"],
      blockedLabels: [],
      allowAuthors: [],
      allowMentionActors: [],
      allowMentionRoles: ["AUTHOR", "OWNER", "MEMBER", "COLLABORATOR"],
    },
    concurrency: {
      runs: 3,
    },
    output: ".magi/runs/issue",
    worktree: ".magi/worktrees/issue",
  },
  clear: {
    output: true,
    worktree: true,
    session: true,
    branch: true,
  },
}
