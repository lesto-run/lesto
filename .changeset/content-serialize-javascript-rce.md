---
"@lesto/content-shared": patch
"@lesto/content-core": patch
---

Bump `serialize-javascript` off the high-severity RCE advisory.

`@lesto/content-shared` pinned `serialize-javascript@^6.0.0` — a range that can never reach the patched `7.0.5` and sits inside GHSA-5c6j-r48x-rmvq (**high: RCE via `RegExp.flags` / `Date.prototype.toISOString()`**) plus GHSA-qj8w-gfj5-8c6v (CPU DoS). Both `content-shared` and `content-core` import it at runtime to serialize collected content into a JS module, so every downstream install shipped the vulnerable serializer on the exact path that serializes content data. Both direct pins are raised to `^7.0.5`, and because `@content-collections/core` transitively pins `serialize-javascript@^6.0.2`, a root `overrides` forces `serialize-javascript >=7.0.5` across the tree — after which `bun audit` reports the advisory cleared. The v7 call signature is unchanged for this object-serialization usage; the existing content suites (which exercise the serializer's only callers) pass unmodified.
