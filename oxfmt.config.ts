import { defineConfig } from "oxfmt"

export default defineConfig({
  bracketSpacing: true,
  ignorePatterns: [
    "dist",
    "node_modules",
    "pnpm-lock.yaml",
    "coverage",
    "*.generated.ts",
    "CHANGELOG.md",
    ".magi/runs",
    ".magi/worktrees",
  ],
  jsxSingleQuote: false,
  printWidth: 80,
  semi: false,
  singleQuote: false,
  sortPackageJson: false,
  tabWidth: 2,
  trailingComma: "all",
})
