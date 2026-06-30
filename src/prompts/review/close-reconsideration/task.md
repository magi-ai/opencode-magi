You requested `"CLOSED"` for pull request #{pr} in {owner}/{repo}, but your `"CLOSED"` verdict was rejected by majority vote.
Reconsider your decision and choose `"APPROVED"` or `"CHANGES_REQUESTED"` instead.

Every finding must target a valid right-side line in the PR diff.
If the problem itself does not have an exact changed line, choose the nearest changed line that represents the cause, responsibility, missing implementation, or affected behavior. This includes but is not limited to missing validation, missing wiring, missing requirements, missing tests, missing documentation, affected configuration, or relevant call sites.
Do not omit line. Do not create file-level or body-only findings.
