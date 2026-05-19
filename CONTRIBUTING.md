## Thanks for your interest in contribute to OpenCode Magi 😎, you are amazing!!!

When it comes to open source, there are different ways you can contribute, all of which are valuable. Here are some guidelines that should help you as you prepare your contribution.

## Setup the Project

The following steps will get you up and running to contribute to OpenCode Magi:

1. Fork the [repository](https://github.com/magi-ai/opencode-magi).

2. Clone your fork locally.

```sh
git clone https://github.com/<your_github_username>/opencode-magi.git

cd opencode-magi
```

3. Install Node.js `>=24.14` and pnpm `10.33.0`.

4. Setup all dependencies by running `pnpm install`.

## Development

OpenCode Magi is an OpenCode plugin for multi-agent GitHub pull request review and merge orchestration.

The project is intentionally small, so please keep contributions focused. If you find another issue while working on a change, open a separate issue or pull request instead of bundling multiple fixes together.

### Tooling

- [PNPM](https://pnpm.io/) to manage packages and dependencies
- [tsgo](https://github.com/microsoft/typescript-go) to typecheck and build TypeScript
- [oxfmt](https://github.com/oxc-project/oxc) to format code
- [oxlint](https://github.com/oxc-project/oxc) to lint code
- [Vitest](https://vitest.dev/) to run unit tests
- [Lefthook](https://lefthook.dev/) to run Git hooks
- [Changesets](https://github.com/changesets/changesets) for changelog and release management

### Commands

- **`pnpm install`**: installs dependencies and prepares Git hooks.
- **`pnpm build`**: builds the plugin with `tsgo`.
- **`pnpm test`**: runs the unit test suite.
- **`pnpm quality`**: runs format check, lint check, typecheck, and tests.
- **`pnpm format:check`**: checks formatting with `oxfmt`.
- **`pnpm lint:check`**: checks lint rules with `oxlint`.
- **`pnpm typecheck`**: runs TypeScript checks without emitting files.
- **`pnpm release:version`**: updates package versions and changelogs from changesets.
- **`pnpm release`**: publishes the package from changesets.

When iterating locally, run the tests that cover your change. Format, lint, and typecheck are also validated by Git hooks and CI, so run them when you need broader validation or before submitting larger changes.

### Testing

Please add or update unit tests when changing behavior around config validation, majority logic, prompt composition, output parsing, or command execution.

Tests must not rely on live GitHub calls. Mock command execution and keep test cases deterministic.

## AI Usage Policy

OpenCode Magi welcomes contributions from everyone, including those created with the assistance of Artificial Intelligence (AI) tools. If you contribute using AI, please disclose it in your issue or pull request and follow the [AI Usage Policy](AI_POLICY.md).

AI-assisted contributions remain the responsibility of the human submitter. Please review, test, and edit generated content before submitting it.

## Think you found a bug?

Please use the [bug report template](https://github.com/magi-ai/opencode-magi/issues/new/choose) and provide a clear path to reproduction.

Useful bug reports usually include:

- The package version you are using
- Your operating system
- Your OpenCode and GitHub CLI setup when relevant
- The exact command or workflow that failed
- The expected behavior and actual behavior
- A minimal reproduction or logs when possible

## Proposing a new feature or changed behavior?

Please use the [feature request template](https://github.com/magi-ai/opencode-magi/issues/new/choose) and explain the problem you want to solve.

For new or changed APIs, configuration options, commands, prompts, or automation behavior, include thoughtful comments and sample usage. Proposals that are unclear, too broad, or not aligned with the project goals may be closed.

## Making a Pull Request?

### Commit Convention

Before you create a Pull Request, please check whether your commits comply with the commit conventions used in this repository.

Follow [Conventional Commits](https://www.conventionalcommits.org) and write commit messages in English.

Use the following format:

```text
<type>(<scope>): <description>
```

The `scope` is optional when there is no clear package, module, or area of change.

Use one of the following types:

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

2. Create a new branch out of the `main` branch. Use the format `<type>/<description>`, where `type` is one of the conventional commit types and `description` is a short kebab-case summary.

```text
fix/config-validation
feat/unanimous-approval
docs/review-flow
test/output-parser
```

3. Keep the pull request focused on one change. Do not bundle unrelated fixes, refactors, or cleanups.

4. Make your changes and add or update tests for behavior changes. Run the relevant tests locally with `pnpm test`.

5. Add a changeset when your change affects published package behavior, public configuration, commands, or release notes. Documentation-only changes usually do not need a changeset.

6. Commit your changes following the [commit convention](#commit-convention).

7. Push your branch and open a pull request using the [pull request template](.github/pull_request_template.md).

8. Include `Closes #<issue-number>` in the pull request body and clearly state whether the change is breaking.

9. If AI was used, mark the appropriate checkbox in the pull request template and confirm that you reviewed the generated content before submitting.

10. Check the Pull Request Checks after opening the pull request. The Quality workflow validates formatting, linting, typechecking, and tests. If there are failures, fix them and update the pull request.

## License

By contributing code to the OpenCode Magi GitHub repository, you agree that your contributed code will be licensed under the MIT license.

### Thank you for reading till the end. I love you too. 💖
