# Changeset Rules

Required when modifying package code, prompt templates, config schema, or package metadata. Create a file in `.changeset/`.

This includes changes to:

- `src/**`
- `schema.json`
- `package.json`

```md
---
"opencode-magi": patch
---

One-sentence summary of the fix in English.
```

**Bump type**

- `patch`: bug fix, internal change
- `minor`: new feature with backward compatibility
- `major`: breaking change (alters existing API)
