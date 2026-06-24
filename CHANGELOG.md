# Changelog

All notable changes to Lesto are recorded here. The public `@lesto/*` packages are
versioned and released together, so one version line covers the whole surface.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Lesto
follows [Semantic Versioning](https://semver.org/) — while pre-1.0, minor releases
may include breaking changes.

## [Unreleased]

### Security

- **web:** a private `.data()` source is now secure by default. Registering a
  `scope: "private"` source with no guards throws `WEB_PRIVATE_DATA_UNGUARDED` at
  registration — before any request — closing the bypass where an island's per-user
  data rode the unguarded `/__lesto/data/*` route a page's `middleware.ts` never
  reaches. To register one, EITHER pass the page's guard chain
  (`.data(source, loader, guards)` — the same `middleware.ts` chain `.page()` takes),
  OR declare the source `access: "request-scoped"` on `defineDataSource` (the explicit
  opt-out: its loader reads only the caller's own request, e.g. a "who am I" session,
  so it leaks nothing unguarded). **Breaking:** an existing private source registered
  without guards now fails at boot — add guards or the `request-scoped` declaration.
  `scope: "shared"` sources are unaffected.
- **router:** an orphan `middleware.ts` — one with no page at or below its directory
  (a typo'd filename or a misplaced file) — now throws `ROUTER_FILE_ORPHAN_MIDDLEWARE`
  at compile time instead of silently never running. A guard that silently doesn't run
  is a fail-open auth hole.
- **content-markdown:** the unified Markdown render path (the md4w WASM fallback, and
  the primary path when remark plugins are configured) now applies the same HTML
  sanitization the hybrid path does, so author HTML can never render unsanitized on
  either path.
- **sites:** `defineSites` now validates each site `name` against `^[a-z0-9_-]+$`,
  rejecting path-traversal-shaped names as defense-in-depth on the static-build
  output paths.

## [0.1.1] - 2026-06-23

The first installable public release of Lesto — the batteries-included, agent-native,
full-stack TypeScript framework. All public `@lesto/*` packages publish together at
this version, with npm provenance via trusted publishing (OIDC).

### Added

- `npm create lesto@latest` scaffolds and boots a new app.
- The first-party battery set on one SQL substrate (SQLite for local, Postgres for
  scale, Cloudflare D1 / Hyperdrive at the edge): data & migrations, the durable queue,
  workflows, cache, auth & authz, mail, admin, feature flags, content, observability,
  and the `lesto` CLI. See [README.md](./README.md) for the full package catalog.

### Fixed

- Packaging: released tarballs now install correctly. `0.1.0` published the literal
  `workspace:*` protocol in dependency specs (npm does not rewrite it), so installs
  failed with `EUNSUPPORTEDPROTOCOL`. Releases are now packed with `bun pm pack` —
  which rewrites `workspace:*` to the exact dependency version — before `npm publish`.

## [0.1.0] - 2026-06-23

Initial publish. **Broken — do not use:** every package shipped the unresolved
`workspace:*` protocol and fails to install. Fixed in `0.1.1`.
