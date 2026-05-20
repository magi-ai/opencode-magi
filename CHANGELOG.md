# opencode-magi

## 0.3.0

### Minor Changes

- [#122](https://github.com/magi-ai/opencode-magi/pull/122) [`1c812e7`](https://github.com/magi-ai/opencode-magi/commit/1c812e73700e52e0d2b4fc20c6c6f93662b94bfd) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Add `triage.prompts.createGuidelines` for appending shared implementation guidance to triage PR creation prompts.

- [#103](https://github.com/magi-ai/opencode-magi/pull/103) [`6c354ea`](https://github.com/magi-ai/opencode-magi/commit/6c354ea18f0fc5b0c8923819b56cade93f027dee) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Add per-run command flags for review, merge, and triage config overrides.

- [#119](https://github.com/magi-ai/opencode-magi/pull/119) [`600ea23`](https://github.com/magi-ai/opencode-magi/commit/600ea238208b8a818f4234139d3284d56fb6b335) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Rename the triage PR creation prompt override from `triage.prompts.createPr` to `triage.prompts.create`.

- [#117](https://github.com/magi-ai/opencode-magi/pull/117) [`25dc3e7`](https://github.com/magi-ai/opencode-magi/commit/25dc3e75fdd5bfa94a8d341c0640cc4b9766f638) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Rename triage PR creation automation from `triage.automation.pr` and `--pr` to `triage.automation.create` and `--create`.

- [#97](https://github.com/magi-ai/opencode-magi/pull/97) [`fbac8c8`](https://github.com/magi-ai/opencode-magi/commit/fbac8c82374ca426093c29fdb107a06280065e04) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Add bounded pull request and linked issue context to review prompts.

- [#52](https://github.com/magi-ai/opencode-magi/pull/52) [`7db86e4`](https://github.com/magi-ai/opencode-magi/commit/7db86e44960dd32743bc4b1f53672340a7fb240e) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Add the Magi issue triage command and configuration.

- [#118](https://github.com/magi-ai/opencode-magi/pull/118) [`6f71628`](https://github.com/magi-ai/opencode-magi/commit/6f71628e18862790c181761130629d6f356f4e6d) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Add triage review and merge follow-up automation after implementation PR creation.

### Patch Changes

- [#107](https://github.com/magi-ai/opencode-magi/pull/107) [`24aa8c9`](https://github.com/magi-ai/opencode-magi/commit/24aa8c940a30f7237779acb20e73da53ba259620) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Allow editor-style agents to run package manager commands by default.

- [#90](https://github.com/magi-ai/opencode-magi/pull/90) [`649d78d`](https://github.com/magi-ai/opencode-magi/commit/649d78db785e82851ef1fe560eba770af57206e2) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Assign triage implementation issues before creating automated PRs.

- [#109](https://github.com/magi-ai/opencode-magi/pull/109) [`3829482`](https://github.com/magi-ai/opencode-magi/commit/38294825c62fe0078acd46fcb24153dd38a5f78f) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Mark active triage creators as cancelled when cancelling a Magi run.

- [#104](https://github.com/magi-ai/opencode-magi/pull/104) [`7c351c8`](https://github.com/magi-ai/opencode-magi/commit/7c351c812cd8d396c032397e6f21ff9e8342ce6f) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Replace hard-coded triage bug and feature kinds with configurable issue categories.

- [#30](https://github.com/magi-ai/opencode-magi/pull/30) [`d97b51a`](https://github.com/magi-ai/opencode-magi/commit/d97b51ac9468a7e99ac325d2c307fce4944acc3c) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Default review merge automation to enabled.

- [#78](https://github.com/magi-ai/opencode-magi/pull/78) [`3d228b2`](https://github.com/magi-ai/opencode-magi/commit/3d228b24fa0e910062afa72dcddea532d6c050d3) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Fix malformed GraphQL used when fetching issue-related pull requests.

- [#65](https://github.com/magi-ai/opencode-magi/pull/65) [`5d7c3fa`](https://github.com/magi-ai/opencode-magi/commit/5d7c3fa115baf6f315db33abae8a9b48909e5164) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Pass the resolved review approval policy into review automation.

- [#100](https://github.com/magi-ai/opencode-magi/pull/100) [`fe72308`](https://github.com/magi-ai/opencode-magi/commit/fe72308faa8e403a642614a1760c57471e6dc0b5) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Retry review model output when inline finding targets are not valid PR diff lines.

- [#96](https://github.com/magi-ai/opencode-magi/pull/96) [`1124ddd`](https://github.com/magi-ai/opencode-magi/commit/1124dddb8e75cbb8233a9bc9e01d6464162b89a3) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Fix triage reruns so unfinished PR, close, and label cleanup automation can complete after a previous marker.

- [#86](https://github.com/magi-ai/opencode-magi/pull/86) [`c4bc42b`](https://github.com/magi-ai/opencode-magi/commit/c4bc42beeae07fdb9134d8d5d71414f6a4a549cf) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Fix triage duplicate searches for issue titles that look like GitHub qualifiers.

- [#63](https://github.com/magi-ai/opencode-magi/pull/63) [`406cd7c`](https://github.com/magi-ai/opencode-magi/commit/406cd7c86653298ddea455f5ffd617e76246327d) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Fetch issue metadata through GraphQL so triage can use issue types without requesting unsupported GitHub CLI JSON fields.

- [#44](https://github.com/magi-ai/opencode-magi/pull/44) [`f6e563a`](https://github.com/magi-ai/opencode-magi/commit/f6e563a663dd505822846553d08fe15f13fe5f07) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Use GitHub GraphQL to enqueue pull requests when merge queue mode is enabled.

- [#46](https://github.com/magi-ai/opencode-magi/pull/46) [`cc377ab`](https://github.com/magi-ai/opencode-magi/commit/cc377ab3db52297fc8c4f58a62590954d566bab3) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Hide internal Magi follow-up tool names from user-facing guidance.

- [#41](https://github.com/magi-ai/opencode-magi/pull/41) [`3bd0e69`](https://github.com/magi-ai/opencode-magi/commit/3bd0e69f7f261e520b5bc3bd48d1d918439542a9) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Avoid unsupported merge flags when queueing pull requests through GitHub merge queue.

- [#42](https://github.com/magi-ai/opencode-magi/pull/42) [`4460d33`](https://github.com/magi-ai/opencode-magi/commit/4460d33ff3e2560eebc261a1af316b7bc30ed762) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Avoid exposing GitHub tokens in failed command messages and Magi run errors.

- [#80](https://github.com/magi-ai/opencode-magi/pull/80) [`23374a1`](https://github.com/magi-ai/opencode-magi/commit/23374a1b2652335c52229c6921386194299498a4) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Remove internal follow-up tools from the public Magi slash command list.

- [#35](https://github.com/magi-ai/opencode-magi/pull/35) [`840ccfa`](https://github.com/magi-ai/opencode-magi/commit/840ccfa9dbf411944a9d1b118682a44e8116169d) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Include pull request links in generated Magi run reports.

- [#102](https://github.com/magi-ai/opencode-magi/pull/102) [`d56dd01`](https://github.com/magi-ai/opencode-magi/commit/d56dd0175244f9ba9888e13bb339c06edcc6c619) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Allow magi_status to accept multiple PR filters.

- [#113](https://github.com/magi-ai/opencode-magi/pull/113) [`03f0059`](https://github.com/magi-ai/opencode-magi/commit/03f005995bbaa068eda73d9b9d9220cb5bd07359) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Keep polling post-edit CI when GitHub temporarily reports no pull request checks.

- [#112](https://github.com/magi-ai/opencode-magi/pull/112) [`ad86c02`](https://github.com/magi-ai/opencode-magi/commit/ad86c020dbdb3701e9569ca49d35a87f13445fcf) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Use triage creator output for automated triage pull request titles and bodies.

- [#109](https://github.com/magi-ai/opencode-magi/pull/109) [`3829482`](https://github.com/magi-ai/opencode-magi/commit/38294825c62fe0078acd46fcb24153dd38a5f78f) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Report triage implementation PR creation progress to the parent Magi run.

- [#99](https://github.com/magi-ai/opencode-magi/pull/99) [`b0c0fcc`](https://github.com/magi-ai/opencode-magi/commit/b0c0fccee54d37b24eeebf33b41c9c8db26236e1) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Validate git worktree config before configuring editor or triage creator identity.

## 0.2.0

### Minor Changes

- [#26](https://github.com/magi-ai/opencode-magi/pull/26) [`1eec16e`](https://github.com/magi-ai/opencode-magi/commit/1eec16e15ea3e337bd87575409dec722c73871fa) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Restructure Magi configuration around review and merge sections.

- [#15](https://github.com/magi-ai/opencode-magi/pull/15) [`90f91ee`](https://github.com/magi-ai/opencode-magi/commit/90f91ee1bb2b234785e8faa61ede26fd1fa3d1f6) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Changed the temporary worktree configuration from `worktree.dir` to `worktree.dirs.pr`. PR worktrees now default to `.magi/worktrees/pr/pr-123` instead of `.magi/worktrees/pr-123`.

### Patch Changes

- [#21](https://github.com/magi-ai/opencode-magi/pull/21) [`7556923`](https://github.com/magi-ai/opencode-magi/commit/75569239dd7b4216f26152e5191bb8e65403311d) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Avoid PR branch checkout conflicts when creating temporary worktrees.

- [#13](https://github.com/magi-ai/opencode-magi/pull/13) [`b87a64d`](https://github.com/magi-ai/opencode-magi/commit/b87a64d0d5589aa624045900c495c249593a0be4) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Update repository URLs to match the current GitHub organization.

- [#11](https://github.com/magi-ai/opencode-magi/pull/11) [`2adb182`](https://github.com/magi-ai/opencode-magi/commit/2adb18255ab9048e1ba5365f2b17da7d01a9bbd0) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Updated dependencies.

- [#29](https://github.com/magi-ai/opencode-magi/pull/29) [`396b5f4`](https://github.com/magi-ai/opencode-magi/commit/396b5f4aa5587e23d81865c6f8e92cca70c2a375) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Group built-in prompt templates and prompt docs by config area.
