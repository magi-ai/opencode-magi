---
name: select-reviewers
description: Compare OpenCode Go models using current Artificial Analysis scores and official pricing, recommend balanced groups of three Magi reviewers, estimate PR review capacity per 5 hours, week, and month, and select non-Go OpenCode free fallbacks. Use when asked to compare Go models, select balanced reviewer trios, estimate how many PRs Go can review, or find free alternatives.
---

## Scope

Collect current public information, produce separate score-sorted tables for Go models and non-Go OpenCode free models, and recommend groups of exactly three Magi reviewers with similar scores and prices. Make estimated PR capacity per 5 hours, week, and month the main practical takeaway for each group. Assign a free fallback candidate to each selected reviewer when a suitable one is available.

This is a recommendation task. Do not change Magi configuration or run reviews unless the user separately requests it.

## Sources

- Available models, token prices, subscription prices, and allowances: https://opencode.ai/v2/docs/console/go/#usage-limits
- Non-Go OpenCode free models, IDs, conditions, and privacy policies: https://opencode.ai/v2/docs/console/models
- Intelligence scores: https://artificialanalysis.ai/leaderboards/models
- Missing scores and evaluation settings: individual model pages linked from https://artificialanalysis.ai

Fetch these sources on every run. Do not reuse model lists, prices, or scores from memory or previous recommendations.

## Collection

1. Read the Go documentation and enumerate every model in its current usage-limits tables. Default to Go, not Go Plus, unless requested otherwise. Collect exact model IDs from the documentation's endpoints table or its linked models endpoint, and verify the full OpenCode identifier `opencode-go/<model-id>`. Omit the provider prefix when displaying IDs in tables. Do not derive IDs from display names; mark unresolved IDs as unconfirmed and exclude those models from reviewer groups.
2. Record input, output, cache-read, and cache-write prices in USD per 1M tokens, plus each model's monthly allowance. Keep the subscription fee separate from token prices and allowances.
3. Record conditional prices and their conditions: long-context thresholds, peak hours, free promotions, and regional restrictions. For each conditional model, use the ordinary-context price and explicitly identify the baseline time tier when grouping; also show the other prices and flag conditions that change the balance.
4. Collect the Artificial Analysis Intelligence Index score for each model, including the index version, evaluated model version, and reasoning setting. Use the highest published score for each exact model version, and disclose this convention.
5. Match exact model identities before assigning scores. A Contributor or Free suffix can describe a service tier, but verify the underlying model. Do not silently equate a different release, dated snapshot, Preview, Flash, or Next variant.
6. If a model is absent from the main leaderboard, follow its individual model page, including deprecated models. When links are hard to find, search the site's sitemap or use a browser for dynamically rendered data instead of repeatedly guessing URLs.
7. Mark unavailable scores as unconfirmed rather than estimating them. A related model's score may be shown separately as a reference, but cannot qualify the unconfirmed model for a trio.
8. Record the access date and source links. If sources are inaccessible or contradict each other, identify the gap instead of claiming a complete, current comparison.

## Non-Go Free Models

1. Read the Console models documentation's pricing, free-model, endpoints, and privacy sections. List every model explicitly available for free through the non-Go OpenCode provider, including models without a Free suffix. Do not assume that free access through Go also means non-Go free access, or include paid trials requiring credits as free models.
2. Verify exact IDs from the official endpoints table or its linked models endpoint. Verify `opencode/<model-id>`, not `opencode-go/<model-id>`, and omit the provider prefix when displaying IDs in tables. A model offered through both providers belongs in both tables under its respective provider context.
3. Collect Intelligence Index scores using the same identity, version, and reasoning-setting rules as for Go models. Keep unknown or stealth models in the free-model table with unconfirmed scores; do not invent their underlying identities.
4. Record whether free access is limited-time, any published end date, region and rate limits, context/tool capabilities, and training or retention conditions. If an end date or limit is not published, say it is unspecified rather than assuming permanent or unlimited access.
5. Distinguish free availability from suitability for Magi reviews. Models that cannot perform ordinary text/tool-based code reviews remain in the inventory but are not fallback candidates. Flag unknown compatibility rather than claiming it has been tested.

## Group Selection

Use score and price similarity as the primary criteria, not merely high scores or low prices.

1. Consider only models with confirmed identities, comparable scores from the same Intelligence Index version, and verified Go pricing and availability. Disclose reasoning settings that may differ from actual Go usage.
2. Look for neighboring score bands whose input, output, and cache-read prices are also close. Include cache-write pricing where applicable. Do not treat a missing cache-write price as zero.
3. Compare candidate trios using their score spread (`highest - lowest`) and separate input, output, and cache-read price ratios (`highest / lowest`). Prefer smaller differences in both scores and prices; explain tradeoffs when no trio is best on both. Do not invent a blended token price without a stated workload.
4. Treat free models separately from paid pricing bands. Do not divide by zero or describe a free/paid mix as price-balanced. If fewer than three comparable free models have confirmed scores, do not force a free trio.
5. Use similar Go allowances and different model creators as tie-breakers. Different creators are only a diversity proxy, not evidence that reviewers make independent errors.
6. Present distinct trios across supported score/price bands, ordered from higher to lower scores. Avoid near-duplicate combinations; models may appear in more than one group when useful. Do not force every model into a group or pad a group with an unsuitable model.
7. Recommend one default trio based on the closest joint score/price match. For each group, show its three models with scores and provider-prefix-free model IDs in its recommendation table. Keep prices and allowances in the Go comparison table, and put relevant caveats in short notes. Put the score range/spread and price ratios in a compact caption. If no balanced trio is supported, say so and label any compromise explicitly.

## PR Capacity Estimation

Estimate quota-limited capacity for every recommended group, not just individual models. These are planning scenarios, not measured Magi throughput or completion-time guarantees.

1. Unless the user specifies a workload, define an illustrative ordinary PR as 300–500 changed lines across 5–10 files, excluding generated files, lockfile-only changes, and large migrations. One PR means one review pass by all three reviewers, not three PRs. Exclude fixes, merge work, retries, and re-reviews; disclose any additional Go-billed orchestration that is excluded.
2. Use the same two explicit synthetic workloads for every group, per reviewer per PR: lighter — 20 API requests, 300K cumulative input (75K uncached / 225K cache-read), 10K output; heavier — 40 requests, 1M cumulative input (500K uncached / 500K cache-read), 50K output. Output includes billable reasoning tokens. These are assumptions, not observed averages or a conversion from changed lines to tokens. Assume each request stays within the ordinary-context pricing tier; cumulative input is not a single request's context. Disclose that actual reasoning and repository exploration may exceed this range. Prefer representative user-provided usage measurements when available and identify the override.
3. Calculate each reviewer's cost separately: `C_i = (input_tokens * input_price + cache_read_tokens * cache_read_price + cache_write_tokens * cache_write_price + output_tokens * output_price) / 1M`. Split uncached tokens into input and cache writes according to the provider's billing rules without double counting. If that split is unknown but write pricing exists, conservatively price uncached tokens at the higher input/write rate and disclose this assumption. Do not treat unpublished write pricing as zero; if cache billing cannot be established, label the gap and use an explicitly uncached scenario instead. Include cold starts; do not assume caches transfer between reviewers or PRs.
4. Read the current shared-quota accounting and 5-hour, weekly, and monthly rules before combining reviewer costs. For shared normalized usage with monthly model allowances `L_i`, compute `u = sum(C_i / L_i)` and `floor(f_window / u)` PRs, where `f_window` is the documented window fraction. Use a per-model bottleneck calculation only when independent model quotas are explicitly confirmed; never add the model allowances or capacities. If mixed-model accounting is unclear, label shared normalized accounting as a conservative planning assumption, not a verified rule. Show the per-reviewer cost range and group quota-consumption range compactly so the estimates are reproducible.
5. Assume all windows start unused, no other Go usage, Extra usage off, and no free-fallback substitution. Compute the lower PR count from the heavier workload and the upper count from the lighter workload, rounding down. Apply conditional context/time pricing and expiring allowance promotions explicitly; show their impact when material. Window counts are overlapping quota ceilings, not additive totals or sustainable repeated 5-hour batches. Check that weekly/monthly ceilings remain consistent with shorter windows and their documented reset rules.
6. Official estimated API requests are not PR counts and use their own token/cache assumptions; do not divide them by a guessed number of requests without reconciling those assumptions. Free pricing does not imply unlimited PRs: if every reviewer is free and no numerical rate limits are published, report capacity as unconfirmed. Keep model score/price balance as the group-selection criterion, but prominently explain the capacity tradeoff between groups.

## Free Fallback Selection

For every reviewer in every proposed group, recommend a fallback from the non-Go free-model table, not from the Go-only free models. Keep this separate from the primary trio's score/price balance.

1. Use only candidates with verified non-Go IDs, current free availability, confirmed comparable scores, and no known compatibility or access restriction that rules them out for the user's use case. Do not presume permission to send confidential code to a trial endpoint that prohibits it; disclose other training and retention differences before recommending its use.
2. Prefer an equivalent underlying model when verified, otherwise minimize the absolute score difference from the primary reviewer. Compare assignments across the whole trio and prefer distinct underlying fallback models when score differences are similar.
3. Show each primary-to-fallback mapping with both scores and provider-prefix-free model IDs. Calculate absolute score differences for selection, but do not display them as a separate column. Put selection-relevant capability or access caveats in short notes. Free candidates are all in the free price tier; do not rank them using paid-model price ratios.
4. Do not silently reuse a fallback across multiple reviewers or choose another reviewer's primary model as its fallback. If distinct suitable candidates are insufficient, disclose any shared fallback and the resulting loss of model diversity, or mark the reviewer as having no suitable free fallback. Do not force an unscored or incompatible model into the assignment.
5. Label all free fallbacks as provisional and subject to promotion expiry, rate limits, and availability changes. Explain that a different provider ID for the same underlying model does not guarantee an independent service, and a shared OpenCode outage may affect both Go and non-Go access.

## Output

Respond in the user's language using only the three sections below: Go model comparison, free model comparison, and recommendations with one table per group. Keep explanations inside table cells or short notes; do not add an opening recommendation paragraph, investigation narrative, separate group-summary table, or separate fallback section/table. Omit `opencode-go/` and `opencode/` from displayed model IDs; the section or recommendation column identifies the provider. Use only the columns in the templates below.

Before the tables, use one compact metadata line for the access date, Intelligence Index version, highest-score convention, subscription fee, and USD per 1M token units. State briefly that allowances are not additional subscription charges.

### Model Comparison (Go)

Sort by score descending. Put unconfirmed scores last.

| Model                            | Model ID                    |                Score | Input / output / cache                                    | Go monthly allowance |
| -------------------------------- | --------------------------- | -------------------: | --------------------------------------------------------- | -------------------: |
| Model name and evaluated variant | `<model-id>` or unconfirmed | Score or unconfirmed | Input / output / read: price, write: price or unavailable |            Allowance |

Keep input, output, cache-read, and cache-write prices in this single pricing column; label cache read and write explicitly. Show conditional rates in additional rows or concise keyed notes, not a separate pricing table. Link scores to their sources, especially for models missing from the main leaderboard.

### Model Comparison (Free)

Sort confirmed scores descending and put unconfirmed scores last. Keep this table separate from the Go comparison even when the same underlying model appears in both.

| Model           | Model ID                    |                Score |
| --------------- | --------------------------- | -------------------: |
| Free model name | `<model-id>` or unconfirmed | Score or unconfirmed |

Do not add price, free-period/limits/capabilities, or data-policy/fallback-suitability columns. Summarize selection-relevant free-period, access, capability, and data-policy conditions in short notes instead.

### Recommendations

Before the groups, give one compact shared workload note defining PR size, the two token/request scenarios, quota-accounting assumptions, and excluded work. Repeat the following heading, prominent PR-capacity line, compact caption, and three-row table for each group, ordered by score band descending. Mark one group as the default recommendation. Put each reviewer's free fallback in the same row; do not repeat the mapping elsewhere.

#### Group Name (Recommended / Band Label)

**Estimated PR capacity: 5 hours ≈ L–U PRs / week ≈ L–U PRs / month ≈ L–U PRs (scenario estimates, not measured).**

Score range / spread; input / output / cache-read price ratios; baseline context and time tier.

Cost per reviewer per PR: A ≈ $L–$U, B ≈ $L–$U, C ≈ $L–$U; group monthly quota consumed per PR ≈ L–U% (state accounting assumption if unconfirmed).

| Go reviewer (score and ID) | Non-Go free fallback (score and ID)                      |
| -------------------------- | -------------------------------------------------------- |
| Model A (score; `<id-a>`)  | Free model (score; `<free-id>`) or no suitable candidate |
| Model B (score; `<id-b>`)  | Free model (score; `<free-id>`) or no suitable candidate |
| Model C (score; `<id-c>`)  | Free model (score; `<free-id>`) or no suitable candidate |

Do not add pricing, Go monthly allowance, absolute score difference, or caveat columns to recommendation tables.

Link sources inline in headings, cells, or notes rather than adding a source-list section. Put shared caveats in at most five short notes without repeating table contents. Include selection-relevant uncertainty and access/data restrictions, provisional fallback availability and shared-outage risk, and that these are unapplied recommendations rather than measured Magi review rankings. Do not turn the collection checklist or Gotchas into a prose report.

## Gotchas

- Intelligence Index measures general capability, not code-review accuracy. These groups are provisional public-information selections, not validated Magi performance rankings.
- Bug-detection rates, false-positive rates, complementary blind spots, actual Magi cost, and completion times require measurements on representative reviews. PR-capacity scenarios are quota-based estimates under explicit workload assumptions, not measurements of those outcomes. Do not infer these from model creators or claim unmeasured specialties.
- Equal token prices do not imply equal review costs: reasoning-token use, cache hits, and repeated context differ. Do not invent request-count or token-cost estimates without explicit assumptions.
- Context pricing thresholds concern an individual API request, not cumulative monthly tokens or an entire review. Review history and tool results can increase later requests. Verify boundary semantics before making exact claims.
- Monthly allowances, shorter rolling limits, and Extra usage are separate from subscription prices. Read the current rules rather than assuming allowance amounts can be added across models.
- A PR with three reviewers consumes all three reviewers' usage. Changed-line counts alone do not determine API calls or reasoning tokens, and official request estimates cannot be relabeled as PR capacity.
- Free promotions can expire, and Contributor tiers may permit model training. Flag these conditions without replacing the user's score/price selection criteria with unrelated criteria.

## Final Check

- Every model from the Go usage-limits tables is represented, including models with unconfirmed scores.
- Every currently documented non-Go free model is represented in a separate table, with confirmed or explicitly unconfirmed IDs and scores. Selection-relevant free-period conditions and restrictions appear in short notes.
- Confirmed scores are descending and use a comparable index version; evaluated variants and settings are identifiable.
- Prices, units, plan, allowances, and conditional rates agree with the cited Go documentation.
- Every model has a verified full OpenCode model ID or an explicit unconfirmed marker. Displayed IDs omit provider prefixes, preserve the correct provider context, and match between recommendation and comparison tables.
- Each proposed group has its own three-row table containing exactly three distinct reviewers with verified IDs; score spreads, prices, and price ratios match the comparison table.
- Every group leads with 5-hour, weekly, and monthly PR-capacity ranges or an explicit unconfirmed result. Workload, per-reviewer costs, quota accounting, conditional rates, rounding, and excluded work support those ranges; lighter usage never yields fewer PRs than heavier usage. Do not present window ceilings as additive or measured throughput.
- Each reviewer row includes a free fallback or an explicit no-candidate result. Fallback IDs resolve under `opencode/`, are listed as non-Go free models, and assignments use correctly calculated score differences. Shared fallback models and access or data-policy restrictions are disclosed in short notes.
- The Go comparison has one combined pricing column; the free comparison has only model, ID, and score columns; each recommendation table has only Go reviewer and non-Go free fallback columns.
- Output contains only the two model-comparison tables, one recommendation table per group, prominent PR-capacity estimates, compact metadata/workload/cost captions, and short notes. There is no separate capacity or fallback table or lengthy explanation.
- Recommendation captions/caveats convey score/price balance and missing evidence without unsupported review-performance claims.
