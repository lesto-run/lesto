---
"@lesto/db": minor
---

Rename the `DB_INVALID_LIMIT` error code to `DB_INVALID_BOUND`.

`assertLimitBound()` validates both the `LIMIT` and the `OFFSET` of a query but always raised the single code `DB_INVALID_LIMIT`, so a caller branching on the code alone could not tell which bound was rejected. The code is now `DB_INVALID_BOUND`, matching the module's concern-named codes (`DB_EMPTY_INSERT`, etc.); `details.clause` still names the specific bound for humans.

**Migration.** If you branch on the thrown code, rename it:

```ts
// before
if (err instanceof DbError && err.code === "DB_INVALID_LIMIT") { … }
// after
if (err instanceof DbError && err.code === "DB_INVALID_BOUND") { … }
```
