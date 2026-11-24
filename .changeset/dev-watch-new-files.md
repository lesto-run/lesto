---
"@lesto/cli": patch
---

`lesto dev` now reloads when you edit a file you created after the dev server started. On Linux under Bun 1.3.x, `fs.watch` reports the new file once and then never reports a change to it again, so an edit to a new helper or component reloaded nothing. The dev watchers now re-arm after each created, deleted or moved entry.
