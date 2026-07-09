---
"@lesto/errors": patch
"@lesto/web": patch
"@lesto/styles": patch
---

Recognize `LestoError` by a process-global brand (`Symbol.for("lesto.error")`) rather than `instanceof`, so error→status mapping survives a duplicate `@lesto/errors` copy in an install. When two copies coexist (as the router/ui `0.1.3` stale-lockfile mispin caused), an error thrown from copy A is not `instanceof` copy B's class — so `@lesto/web`'s `statusForError` missed the coded mapping (e.g. `ROUTER_MALFORMED_PARAM` → 400) and silently downgraded it to a 500. `isLestoError`/`hasCode` now duck-type the brand (plus a string-`code` sanity check so the `value is LestoError` guard can't type-lie), which the global symbol registry resolves identically in every copy, and both `@lesto/web`'s `statusForError` and `@lesto/styles`'s `buildStyles` coded-error re-throw gate now recognize by `isLestoError` — so no remaining base-class `instanceof LestoError` can silently remap or swallow a coded error under a dep-dup. No static `Symbol.hasInstance` was added — it would be inherited by the 40+ `LestoError` subclasses and break their `instanceof` subclass discrimination; same-copy `instanceof LestoError` is unchanged.
