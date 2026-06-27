# Signal

Used when `triage.signals` is configured and Magi has already selected the final triage disposition and category.

Built-in template: [`triage/signal.md`](/src/prompts/templates/triage/signal.md)

| Placeholder          | Meaning                                                        |
| -------------------- | -------------------------------------------------------------- |
| `{issue}`            | Issue number.                                                  |
| `{owner}` / `{repo}` | GitHub repository owner and name.                              |
| `{signalOptions}`    | Configured signal IDs and descriptions.                        |
| `{context}`          | Final triage result plus issue context used for signal voting. |
