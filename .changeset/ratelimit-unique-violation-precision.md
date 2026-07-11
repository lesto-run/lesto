---
"@lesto/ratelimit": patch
---

Tighten `isUniqueViolation` so it recognizes only genuine UNIQUE/PRIMARY KEY conflicts.

The SQLite branch matched any code starting with `SQLITE_CONSTRAINT`, which is also true for `SQLITE_CONSTRAINT_NOTNULL` / `_CHECK` / `_FOREIGNKEY` / `_TRIGGER` — not only `_UNIQUE` / `_PRIMARYKEY`. It now matches exactly `SQLITE_CONSTRAINT_UNIQUE` / `SQLITE_CONSTRAINT_PRIMARYKEY` (bare-code drivers still match via the `"UNIQUE constraint failed"` message branch; Postgres `23505` is unchanged).

This helper is shared with `@lesto/identity`'s `register`, where the loose match could have swallowed a `NOT NULL` violation on the `users` table as a fake "verification sent" success. Such errors now propagate correctly, matching the Postgres behavior.
