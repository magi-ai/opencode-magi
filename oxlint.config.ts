import { defineConfig } from "oxlint"

export default defineConfig({
  env: {
    builtin: true,
    node: true,
  },
  ignorePatterns: ["dist", "node_modules", "coverage", ".magi"],
  jsPlugins: ["eslint-plugin-unused-imports"],
  options: { typeAware: true },
  plugins: ["eslint", "typescript", "unicorn", "import"],
  rules: {
    "typescript/no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      },
    ],
    "unused-imports/no-unused-imports": "error",
  },
})
