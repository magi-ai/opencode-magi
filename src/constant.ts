import type { Config } from "./config"
import { homedir } from "node:os"
import { join } from "node:path"
import commonPermissions from "./permissions/common.json" with { type: "json" }
import editPermissions from "./permissions/editor.json" with { type: "json" }

export const CONFIG_PATH = {
  GLOBAL: join(homedir(), ".config", "opencode", "magi.json"),
  PROJECT: join(".opencode", "magi.json"),
}
export const DEFAULT_CONFIG: Config.Root = {
  agents: {
    permissions: commonPermissions as Config.Permissions,
  },
  clear: {
    branch: true,
    output: true,
    session: true,
    worktree: true,
  },
  github: { apiRetryAttempts: 3, host: "github.com" },
  language: "en",
  merge: {
    automation: {
      close: false,
      conflict: false,
      merge: true,
    },
    checks: {
      wait: true,
    },
    editor: {
      permissions: editPermissions as Config.Permissions,
    },
    maxThreadResolutionCycles: 5,
  },
  mode: "single",
  output: {
    repairAttempts: 3,
  },
  review: {
    automation: {
      close: false,
      merge: true,
    },
    checks: {
      exclude: [],
      retryFailedJobs: 3,
      wait: true,
    },
    concurrency: {
      reviewers: 3,
      runs: 3,
    },
    merge: {
      approvalPolicy: "majority",
      auto: true,
      deleteBranch: true,
      method: "squash",
      queue: false,
    },
    output: ".magi/runs/pr",
    safety: {
      allowAuthors: [],
      blockedPaths: [],
      requiredLabels: [],
    },
    worktree: ".magi/worktrees/pr",
  },
  triage: {
    automation: {
      close: false,
      create: false,
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
      merge: false,
      review: false,
    },
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
    concurrency: {
      runs: 3,
    },
    creator: {
      permissions: editPermissions as Config.Permissions,
    },
    output: ".magi/runs/issue",
    safety: {
      allowAuthors: [],
      allowMentionActors: [],
      allowMentionRoles: ["AUTHOR", "OWNER", "MEMBER", "COLLABORATOR"],
      blockedLabels: [],
      requiredLabels: ["triage"],
    },
    worktree: ".magi/worktrees/issue",
  },
}
