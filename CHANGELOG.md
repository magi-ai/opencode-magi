# opencode-magi

## 0.10.0

### Minor Changes

- [#298](https://github.com/magi-ai/opencode-magi/pull/298) [`a0a11c5`](https://github.com/magi-ai/opencode-magi/commit/a0a11c55671abdaa838971fd767b211f151bb9a7) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Add single-mode identity support for issue triage.

- [#295](https://github.com/magi-ai/opencode-magi/pull/295) [`8a5cd77`](https://github.com/magi-ai/opencode-magi/commit/8a5cd779494605f8b6c6589f2f99b93f153b3b06) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Promote review identity mode and account settings to top-level configuration.

## 0.9.0

### Minor Changes

- [#287](https://github.com/magi-ai/opencode-magi/pull/287) [`18a05b6`](https://github.com/magi-ai/opencode-magi/commit/18a05b65c7de1d95d52bc2ea782393c6ecc9c67e) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Add single-account review mode for multi-agent PR review consensus.

### Patch Changes

- [#292](https://github.com/magi-ai/opencode-magi/pull/292) [`8ae9cb9`](https://github.com/magi-ai/opencode-magi/commit/8ae9cb999e3c5c757b2622d9fa7bfed46fb591e0) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Default PR review identity mode to single-account posting.

- [#293](https://github.com/magi-ai/opencode-magi/pull/293) [`31900a0`](https://github.com/magi-ai/opencode-magi/commit/31900a0f9502927edf509cf28590ff5f7f7a784c) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Updated dependencies.

- [#290](https://github.com/magi-ai/opencode-magi/pull/290) [`140b838`](https://github.com/magi-ai/opencode-magi/commit/140b8383bf4a655f5c17d5e2b8d049d9fd266a2d) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Improve single-account review summaries and logical reviewer thread routing.

## 0.8.0

### Minor Changes

- [#284](https://github.com/magi-ai/opencode-magi/pull/284) [`8394b29`](https://github.com/magi-ai/opencode-magi/commit/8394b298dc6dd38e7f33c87aa5a824aef9a8e011) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Add optional merge queue conflict recovery for `/magi:merge` via `merge.automation.conflict`.

- [#283](https://github.com/magi-ai/opencode-magi/pull/283) [`aaf5554`](https://github.com/magi-ai/opencode-magi/commit/aaf55543ebec4f6e3c3b8dea1b63bec861a64249) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Add merge conflict context to review and re-review prompts.

- [#285](https://github.com/magi-ai/opencode-magi/pull/285) [`c498630`](https://github.com/magi-ai/opencode-magi/commit/c49863097edbf6c20ee11e2e89567509d9125f93) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Add configurable triage label automation and align triage dispositions.

### Patch Changes

- [#284](https://github.com/magi-ai/opencode-magi/pull/284) [`8394b29`](https://github.com/magi-ai/opencode-magi/commit/8394b298dc6dd38e7f33c87aa5a824aef9a8e011) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Label merge queue conflict recovery editor output distinctly in merge reports.

## 0.7.0

### Minor Changes

- [#263](https://github.com/magi-ai/opencode-magi/pull/263) [`41a33d6`](https://github.com/magi-ai/opencode-magi/commit/41a33d6a295e10a8fe4612959d1e02ceaa8aa61b) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Support ordered model candidate arrays with per-model options in Magi config.

- [#274](https://github.com/magi-ai/opencode-magi/pull/274) [`1c2b888`](https://github.com/magi-ai/opencode-magi/commit/1c2b8880151b20f40d34d82e0d1f33c4866c07a0) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Rename review and triage config agent lists to reviewers and voters.

- [#279](https://github.com/magi-ai/opencode-magi/pull/279) [`5055cf2`](https://github.com/magi-ai/opencode-magi/commit/5055cf2c1c5b7fd3a74f165a0fefe49720f09a2a) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Support single model objects with per-model options in Magi config.

### Patch Changes

- [#276](https://github.com/magi-ai/opencode-magi/pull/276) [`1c9ede7`](https://github.com/magi-ai/opencode-magi/commit/1c9ede70948731df1e540f58a1004f7efd227ad2) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Use the canonical majority reason for non-ASK triage comments.

- [#262](https://github.com/magi-ai/opencode-magi/pull/262) [`2f91cd2`](https://github.com/magi-ai/opencode-magi/commit/2f91cd2cf0fa246e3541503c4992345981e0059b) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Make non-ASK triage comments read like natural issue comments.

- [#266](https://github.com/magi-ai/opencode-magi/pull/266) [`dca6400`](https://github.com/magi-ai/opencode-magi/commit/dca640049f67951ad489ef5602f4b909997e4b2a) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Prevent magi_clear from accepting assistant-provided cleanup selectors or resource flags.

- [#271](https://github.com/magi-ai/opencode-magi/pull/271) [`b9c3ac2`](https://github.com/magi-ai/opencode-magi/commit/b9c3ac271d78088dbb6ffae3ed209be6dd708365) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Fail command execution when configuration validation fails.

## 0.6.1

### Patch Changes

- [#252](https://github.com/magi-ai/opencode-magi/pull/252) [`762abc7`](https://github.com/magi-ai/opencode-magi/commit/762abc70b0d3a845eb63017f25b2798ddc8975b1) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Honor configured structured output repair attempts in triage model calls.

- [#246](https://github.com/magi-ai/opencode-magi/pull/246) [`aef1c0f`](https://github.com/magi-ai/opencode-magi/commit/aef1c0fbfb364743b9835a4be939f4ec64033a6c) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Fix the existing PR triage prompt to use the structured vote names required by the output contract.

- [#249](https://github.com/magi-ai/opencode-magi/pull/249) [`b565176`](https://github.com/magi-ai/opencode-magi/commit/b565176068c9c84e98c8ced8fa1ec2537d8380fd) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Limit fetchIssue CLI fallback to issue type schema errors.

- [#250](https://github.com/magi-ai/opencode-magi/pull/250) [`c07b95a`](https://github.com/magi-ai/opencode-magi/commit/c07b95a15b934b9495fc8adfe505780f31f53ee0) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Remove unused triage comment and question prompt configuration keys.

- [#254](https://github.com/magi-ai/opencode-magi/pull/254) [`e2a167b`](https://github.com/magi-ai/opencode-magi/commit/e2a167b6b6d2dc80fe4cb106a0c6bda39db32a6d) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Wait only for required pull request checks during CI gating.

## 0.6.0

### Minor Changes

- [#210](https://github.com/magi-ai/opencode-magi/pull/210) [`e0d38da`](https://github.com/magi-ai/opencode-magi/commit/e0d38da362d159698e81ae6976d12753aa1ccca4) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Nest Magi-created OpenCode model sessions under the invoking OpenCode session.

- [#173](https://github.com/magi-ai/opencode-magi/pull/173) [`644e317`](https://github.com/magi-ai/opencode-magi/commit/644e317aaaffc6a32000a7f2ce1c917ab2e99fb9) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Revise triage comment ownership to use triage agent accounts and reporter-based final decision comments.

- [#222](https://github.com/magi-ai/opencode-magi/pull/222) [`2a586c2`](https://github.com/magi-ai/opencode-magi/commit/2a586c2fed4e6769809069867fab243aadf1f6a5) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Generate default triage agent keys as voter-based identifiers.

### Patch Changes

- [#219](https://github.com/magi-ai/opencode-magi/pull/219) [`85d7acf`](https://github.com/magi-ai/opencode-magi/commit/85d7acf2420dde12814f5b63645921aaabc24301) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Abort active child model sessions when synchronous Magi runs time out or fail.

- [#198](https://github.com/magi-ai/opencode-magi/pull/198) [`865fe49`](https://github.com/magi-ai/opencode-magi/commit/865fe49b24b26e925f3e25ac2590e31a1c275394) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Align review inline target validation with the prompted three-dot diff ranges.

- [#233](https://github.com/magi-ai/opencode-magi/pull/233) [`d46a3ab`](https://github.com/magi-ai/opencode-magi/commit/d46a3abeabc83f861be2387fdb3e21d750ccaa93) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Prompt reviewers to request changes when scope-in CI failures are present.

- [#208](https://github.com/magi-ai/opencode-magi/pull/208) [`a1ba8a2`](https://github.com/magi-ai/opencode-magi/commit/a1ba8a2eacb12479f8d45e93a1b48b639db9a79e) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Report every failed check returned by CI classifier runs in progress and run state.

- [#206](https://github.com/magi-ai/opencode-magi/pull/206) [`c691db8`](https://github.com/magi-ai/opencode-magi/commit/c691db8f0d18453a4d2b6e7d81b39c100af8ba04) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Enforce configured triage run concurrency for background triage commands.

- [#201](https://github.com/magi-ai/opencode-magi/pull/201) [`d9498a3`](https://github.com/magi-ai/opencode-magi/commit/d9498a308282db4930fde1b03c1c4b23d7b83719) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Use the dry-run edited head when composing merge close reconsideration prompts.

- [#200](https://github.com/magi-ai/opencode-magi/pull/200) [`16529d2`](https://github.com/magi-ai/opencode-magi/commit/16529d2a553bda4f079e5fe19cd71a4cfb406a48) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Fail CI classification when any classifier agent fails instead of ignoring the failed vote.

- [#231](https://github.com/magi-ai/opencode-magi/pull/231) [`441ff9e`](https://github.com/magi-ai/opencode-magi/commit/441ff9e90ecf0a2f04098c2f87942afb85dcb520) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Fetch missing pull request diff commits before building local review targets.

- [#202](https://github.com/magi-ai/opencode-magi/pull/202) [`c87fcbf`](https://github.com/magi-ai/opencode-magi/commit/c87fcbfe4fd1240351f149ed3efc3d130e34bc2a) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Keep blocking merge review findings editable when no unresolved review threads exist.

- [#190](https://github.com/magi-ai/opencode-magi/pull/190) [`09d54cf`](https://github.com/magi-ai/opencode-magi/commit/09d54cfc1d60f00c274cd7c5f4733bf84b95b037) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Use the documented merge.editor config key in missing editor errors.

- [#193](https://github.com/magi-ai/opencode-magi/pull/193) [`897f865`](https://github.com/magi-ai/opencode-magi/commit/897f865198cc93fca9f08b15beb8a92089c0cd70) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Show merge-specific wording when asynchronous Magi merge runs start.

- [#195](https://github.com/magi-ai/opencode-magi/pull/195) [`4b9f3ce`](https://github.com/magi-ai/opencode-magi/commit/4b9f3cedde524024205ffb9e999a70eba04abbdd) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Paginate pull request review, commit, and review thread GraphQL reads used by review orchestration.

- [#197](https://github.com/magi-ai/opencode-magi/pull/197) [`aed7132`](https://github.com/magi-ai/opencode-magi/commit/aed71324521d48b02a3a9d7f9839603a1152ed39) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Preserve inline findings when reusing current changes-requested reviews.

- [#230](https://github.com/magi-ai/opencode-magi/pull/230) [`58ae429`](https://github.com/magi-ai/opencode-magi/commit/58ae4295d4e9672389e1a97955d3e1a312d2eeed) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Enforce configured concurrency for background review and merge runs.

- [#218](https://github.com/magi-ai/opencode-magi/pull/218) [`6eccff4`](https://github.com/magi-ai/opencode-magi/commit/6eccff489c3529dda2209d58aed17f85ff16cd50) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Only apply synchronous Magi start timeouts when users pass an explicit --timeout flag.

- [#203](https://github.com/magi-ai/opencode-magi/pull/203) [`8f2dd2a`](https://github.com/magi-ai/opencode-magi/commit/8f2dd2aba667a5475993704d2a2227dcdfc3f9fa) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Reconsider minority CLOSE verdicts returned by rereview reviewers before posting.

- [#194](https://github.com/magi-ai/opencode-magi/pull/194) [`875ce29`](https://github.com/magi-ai/opencode-magi/commit/875ce297caffb7e27c21f5c7cb4e9d1259bd557b) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Reject unsupported GitHub review states instead of treating them as close votes.

- [#207](https://github.com/magi-ai/opencode-magi/pull/207) [`44e685d`](https://github.com/magi-ai/opencode-magi/commit/44e685da1cd5917a217545f66a5dfa756dc587ab) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Remove unused legacy check-wait helpers from GitHub command utilities.

- [#158](https://github.com/magi-ai/opencode-magi/pull/158) [`c42b288`](https://github.com/magi-ai/opencode-magi/commit/c42b2883071660719e6f6f67c424ec7dc8eb1325) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Remove default and maximum wait timeouts from synchronous Magi runs and blocking status checks.

- [#223](https://github.com/magi-ai/opencode-magi/pull/223) [`43ee0ce`](https://github.com/magi-ai/opencode-magi/commit/43ee0ce7a7192f201e7d2f401a801ff52b840fc3) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Remove the obsolete triage action model run from final triage decisions.

- [#225](https://github.com/magi-ai/opencode-magi/pull/225) [`ceab514`](https://github.com/magi-ai/opencode-magi/commit/ceab5146a6b4de929facf3bd81bce7645d2728dc) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Rename triage vote output metadata from reviewer-oriented fields to voter-oriented fields.

- [#220](https://github.com/magi-ai/opencode-magi/pull/220) [`c179203`](https://github.com/magi-ai/opencode-magi/commit/c1792036b3c58eaa5e6fc722929e885d6702742a) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Run triage comment classification as the configured reporter and persist its session for cleanup.

- [#221](https://github.com/magi-ai/opencode-magi/pull/221) [`f2af027`](https://github.com/magi-ai/opencode-magi/commit/f2af0273b8f54c7c2eb37979f91b78d0fbeaf17b) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Use run-scoped Magi worktree paths to avoid collisions between repeated runs for the same issue or pull request.

- [#199](https://github.com/magi-ai/opencode-magi/pull/199) [`c7727dc`](https://github.com/magi-ai/opencode-magi/commit/c7727dc0f340b0fb3e00f299f4aaf78d682b1c06) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Validate rereview new findings before posting request-changes comments.

- [#209](https://github.com/magi-ai/opencode-magi/pull/209) [`140eb68`](https://github.com/magi-ai/opencode-magi/commit/140eb6869f22d2aa96b71795a3986ebf55579ee2) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Wait for non-queue auto-merge completion before reporting a pull request as merged.

## 0.5.0

### Minor Changes

- [#146](https://github.com/magi-ai/opencode-magi/pull/146) [`a800653`](https://github.com/magi-ai/opencode-magi/commit/a8006534b15fc13e559429dcf028fbba3d97b2e0) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Add synchronous run mode for review, merge, and triage commands.

### Patch Changes

- [#151](https://github.com/magi-ai/opencode-magi/pull/151) [`78c29fd`](https://github.com/magi-ai/opencode-magi/commit/78c29fde8f32e2c5c6b918d11d71affd57db3e93) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Restore skipped merge review requirement findings even when the prior review body omitted the requirement section heading.

- [#156](https://github.com/magi-ai/opencode-magi/pull/156) [`69606ae`](https://github.com/magi-ai/opencode-magi/commit/69606ae9ac112476f034a68a8bdc7e1a7793fb07) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Skip pull request references when building review issue context.

- [#149](https://github.com/magi-ai/opencode-magi/pull/149) [`42db8d1`](https://github.com/magi-ai/opencode-magi/commit/42db8d14d061c374a6bc0dadbd12b237a6128c06) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Sanitize duplicate issue search queries before passing issue titles to GitHub CLI.

- [#153](https://github.com/magi-ai/opencode-magi/pull/153) [`a1e66ee`](https://github.com/magi-ai/opencode-magi/commit/a1e66ee8fda7247ed3c54a7ff04d609e7d96c90f) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Require review requested changes to be posted as inline GitHub review comments.

## 0.4.0

### Minor Changes

- [#139](https://github.com/magi-ai/opencode-magi/pull/139) [`8d0daa5`](https://github.com/magi-ai/opencode-magi/commit/8d0daa57bf4d3651c9791624cfb193348f82c260) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Add reusable agents.refs presets for Magi agent configuration.

### Patch Changes

- [#124](https://github.com/magi-ai/opencode-magi/pull/124) [`340251d`](https://github.com/magi-ai/opencode-magi/commit/340251dc8b911f1c443dc9056a67eb759ebf2b7b) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Include skipped current review findings when merge editing addresses requested changes.

- [#124](https://github.com/magi-ai/opencode-magi/pull/124) [`340251d`](https://github.com/magi-ai/opencode-magi/commit/340251dc8b911f1c443dc9056a67eb759ebf2b7b) Thanks [@hirotomoyamada](https://github.com/hirotomoyamada)! - Allow review findings without inline diff line targets to be posted and handed to the merge editor.

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
