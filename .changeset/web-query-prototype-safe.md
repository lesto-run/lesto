---
"@lesto/web": patch
---

`c.query(name)` and `c.queries(name)` no longer leak `Object.prototype` members for a key that names one.

The query maps are plain objects, so `c.query("toString")` returned the inherited `toString` **function** (violating its `string | undefined` type) and `c.queries("constructor")` returned `[Object]`. Both accessors now gate on the value's shape — `query()` returns a value only when it is an own string, and `queries()` accepts a `queryAll` entry only when it is an actual array — so a prototype-member key reads as absent (`undefined` / `[]`). The transports already build `queryAll` with a null prototype; this hardens the public accessor to be safe regardless of how the request maps were constructed.
