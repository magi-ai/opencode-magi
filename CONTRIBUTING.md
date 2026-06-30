<p align='center'>
  English | <a href='CONTRIBUTING.ja.md'>日本語</a>
</p>

# Contributing to OpenCode Magi

## Thanks for your interest in contribute to OpenCode Magi 😎, you are amazing!!!

There are several ways to contribute to open source, and all of them are valuable. These guidelines should help you prepare your contribution.

## Setup the Project

The following steps will get you up and running to contribute to OpenCode Magi.

1. Fork the [repository](https://github.com/magi-ai/opencode-magi).

2. Clone it locally.

```sh
git clone https://github.com/<your_github_username>/opencode-magi.git

cd opencode-magi
```

3. Install Node.js (`>=24.14`) and pnpm (`10.33.0`).

4. Run `pnpm install` to set up all dependencies.

## Development

OpenCode Magi is an OpenCode plugin for multi-agent GitHub PR review and merge orchestration.

The project is intentionally small, so please keep contributions focused. If you find another issue while working on a change, open a separate issue or PR instead of bundling multiple fixes together.

### Tooling

- [PNPM](https://pnpm.io/): package and dependency management.
- [tsgo](https://github.com/microsoft/typescript-go): TypeScript typechecking and builds.
- [oxfmt](https://github.com/oxc-project/oxc): code formatting.
- [oxlint](https://github.com/oxc-project/oxc): code linting.
- [Vitest](https://vitest.dev/): unit tests.
- [Lefthook](https://lefthook.dev/): Git hooks.
- [Changesets](https://github.com/changesets/changesets): changelog and release management.

### Commands

- **`pnpm install`**: installs dependencies and prepares Git hooks.
- **`pnpm build`**: runs the build.
- **`pnpm test`**: runs tests.
- **`pnpm quality`**: runs formatting, rule checks, typechecking, and tests.
- **`pnpm format:check`**: runs the formatting check.
- **`pnpm lint:check`**: runs the rule check.
- **`pnpm typecheck`**: runs typechecking.
- **`pnpm release:dev`**: publishes the dev package.
- **`pnpm release`**: publishes the package.

## AI Usage Policy

OpenCode Magi welcomes contributions from everyone, including those created with the assistance of Artificial Intelligence (AI) tools. If you contribute using AI, please follow the [AI Usage Policy](AI_POLICY.md).

## Think you found a bug?

Please use the [template](https://github.com/magi-ai/opencode-magi/issues/new?template=bug_report.yml) and provide the details.

## Proposing a new or changed API?

Please use the [template](https://github.com/magi-ai/opencode-magi/issues/new?template=feature_request.yml) and provide the details.

## Making a Pull Request?

### Commit Convention

Before you create a pull request, please check whether your commits comply with the commit conventions used in this repository.

Follow [Conventional Commits](https://www.conventionalcommits.org) and write commit messages in English.

Use the following format.

```text
<type>(<scope>): <description>
```

The `scope` is optional when there is no clear area of change.

Use one of the following types.

- `feat`: changes that introduce completely new code or new features
- `fix`: changes that fix a bug
- `test`: changes regarding tests
- `docs`: changes to documentation
- `refactor`: code changes that are not fixes or features
- `chore`: repository maintenance that does not fit another category
- `ci`: changes regarding continuous integration
- `build`: changes regarding build tooling, dependencies, or packaging
- `perf`: changes that improve performance
- `style`: changes that do not affect code behavior

Examples:

```text
fix(config): reject duplicate reviewer accounts
feat(review): add unanimous approval policy
docs(prompts): explain output contracts
test(merge): cover majority decision handling
build: update release workflow
```

### Steps to PR

1. Fork and clone the [repository](https://github.com/magi-ai/opencode-magi).

2. Create a new branch out of the `main` branch. Use the format `<type>/<description>`, where `type` is one of the [Conventional Commits](https://www.conventionalcommits.org) types and `description` is a short kebab-case summary.

```text
fix/config-validation
feat/unanimous-approval
docs/review-flow
test/output-parser
```

3. Keep the pull request focused on one change. Do not bundle unrelated fixes, refactors, or cleanups.

4. Make your changes and add or update tests for behavior changes. Run the relevant tests locally with `pnpm test`.

5. If your change affects published package behavior, public configuration, commands, or release notes, run `pnpm changeset` and add a changeset file. Documentation-only changes do not need a changeset file.

6. Commit your changes following the [commit convention](#commit-convention).

7. Push your branch and create a pull request using the [template](.github/pull_request_template.md).

## License

By contributing code to the OpenCode Magi GitHub repository, you agree that your contributed code will be licensed under the MIT license.

### Thank you for reading till the end. I love you too. 💖
