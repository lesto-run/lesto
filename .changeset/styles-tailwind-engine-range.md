---
"@lesto/styles": patch
---

Range the Tailwind engine deps (`@tailwindcss/node`, `@tailwindcss/oxide`) and the `tailwindcss` devDep to `^4.3.0`, matching the `tailwindcss` peer range. Tailwind ships `@tailwindcss/node@X` with an exact hard-dep on `tailwindcss@X`, so pinning the engine exact while the app's peer floats `^4.3.0` re-split the tree into two `tailwindcss` copies on the next patch — in-repo and in every downstream install. Ranging engine + peer in lockstep dedupes to the single instance the app's `@import "tailwindcss"` pulls (which shadcn Phase 2 expects resolvable), and keeps it deduped across future 4.3.x bumps. In-repo reproducibility is unaffected — `bun.lock` still pins the resolved version.
