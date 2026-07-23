# Test Rules

Follow these rules when creating or modifying automated tests.

## Test Level

- Add unit tests for individual functions, class methods, config resolution, config validation, prompt composition, output parsing, report formatting, and other isolated behavior.
- Add integration or flow tests for orchestration across modules, command sequencing, retries, safety gates, run state, review flow, merge flow, triage flow, and CI handling.
- Add scenario tests when a user-visible command crosses multiple decisions or long-running phases.
- Name command scenario suites `scenario: /magi:<command>` and keep their fixtures explicit in the test file.
- Do not use a broad flow test as a substitute for focused unit tests of the functions it depends on.

## File Placement

- Put test files next to their source as `src/**/*.test.ts`.
- Name the test file after the source file, for example `src/config/validate.ts` and `src/config/validate.test.ts`.
- Keep single-file helpers and fixtures in the test file.
- Put shared test infrastructure in `test/**`, not in production source directories.
- Extract a shared fixture only after multiple test files need the same setup.

## Suite Structure

- Give every exported function under test its own `describe("<function>")` block.
- For a class, use `describe("<Class>")` as the root and nest `describe("<method>")` for each public method under test.
- Test private functions through observable public behavior. Do not export or access private implementation solely for testing.
- Keep one behavior per test and name the test after the observable result.
- Keep normal, boundary, invalid-input, error, fallback, and cleanup cases separate when they protect different behavior.

## Imports

- Use the configured Vitest globals. Do not import `describe`, `test`, `expect`, `beforeEach`, `afterEach`, `beforeAll`, `afterAll`, or `vi` from `vitest`.
- Import a custom `test` only when a `test.extend` fixture is required.
- Import `test as base` only in the fixture module that defines an extended test.
- Import only values and types that the file uses. Remove unused, redundant, and globals-only imports.
- Prefer type-only imports when an import is used only as a type.

## Assertions

- Test observable behavior: return values, persisted data, emitted output, external calls, and surfaced errors.
- Do not assert private state or duplicate the implementation in the test.
- Use `toBe` for primitive values and identity, and `toStrictEqual` for complete arrays and objects.
- Use partial matchers only when fields outside the assertion are intentionally irrelevant.
- Await every asynchronous expectation.
- Assert mock call arguments and counts when delegation or command construction is part of the contract.
- Prefer explicit assertions over snapshots for small structured output.

## Fixtures And Mocks

- Create fresh mutable state, class instances, and mocks for each test. Do not share a generated instance across tests.
- Keep fixtures small and provide only the fields required by the behavior under test.
- Use `test/setup.ts` only for setup that must apply to every test file, such as preventing live SDK calls.
- Keep suite-specific module mocks in the test file.
- Mock external boundaries such as GitHub CLI, OpenCode sessions, model responses, authentication, and network calls.
- Prefer dependency injection or a partial module mock that preserves unrelated real exports.
- Use temporary directories for filesystem behavior and remove them after each test.
- Restore fake timers, spies, replaced globals, and module mocks before the next test.
- Never rely on live GitHub state, local authentication, network availability, test execution order, or repository state outside the test fixture.

## Coverage

- For a new unit-test suite, cover every reachable statement, branch, function, and line in the target source file.
- Use coverage to identify missing behavior, not as a reason to assert implementation details.
- Do not add invalid runtime inputs, global monkey patches, coverage exclusions, or meaningless tests solely to increase a metric.
- Do not change production code solely to make coverage easier.
- If a branch is unreachable, redundant, or exposes a production bug, stop and report it. Change production behavior only when the task explicitly includes that fix.
- Add a regression test before or with every bug fix.

## Verification

Run the smallest relevant test first:

```bash
pnpm vitest run src/path/to/file.test.ts
```

Then verify coverage for the exact source file:

```bash
pnpm vitest run src/path/to/file.test.ts --coverage --coverage.include=src/path/to/file.ts
```
