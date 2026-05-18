# Commit Rules

Follow [Conventional Commits](https://www.conventionalcommits.org) for the commit message. Write commit messages in English.

**Format:** `<type>(<scope>): <description>`

- `scope` is the package name, command name, or area of change (e.g., `config`, `github`, `review`, `merge`, `prompts`, `docs`, `deps`, `changesets`).
- `description` starts with a lowercase verb.

**Examples:**

```text
fix(review): handle missing pull request metadata
feat(config): add project override validation
refactor(prompts): simplify review prompt composition
docs(config): document reviewer account setup
test(majority): cover tie-breaking decisions
ci(changesets): update release workflow
chore(deps): update codecov-action to v5
build: copy prompt templates before compiling
```
