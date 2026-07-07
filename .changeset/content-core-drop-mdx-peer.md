---
"@lesto/content-core": patch
---

Drop the `@lesto/content-mdx` optional `peerDependency` (kept as a devDependency). `@lesto/content-mdx` is a private, unpublished package, so the published peer declaration resolved to `0.1.0` (404 on npm) — an unsatisfiable pointer. It was also the sole dependency-graph edge that made `changeset version`/`publish` abort validation (a public package must not depend on a version-skipped private one). The MDX integration in `content-core/src/transformer.ts` is a guarded `await import("@lesto/content-mdx")` with an "install it" fallback, so runtime behavior is unchanged; the type-only import + in-repo tests keep resolving via the devDependency. Re-add the optional peer once `@lesto/content-mdx` is published.
