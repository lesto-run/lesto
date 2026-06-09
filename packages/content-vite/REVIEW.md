# @usedocks/vite-plugin Review

## Summary

This Vite plugin integrates Docks content collections into Vite builds, handling content generation at build time, file watching with HMR during development, optional raw markdown serving, and bundle size monitoring. The plugin is functional with 242 lines of focused code but has significant robustness gaps: missing `optimizeDeps` exclusion, no `server.fs.allow` support for strict frameworks like SvelteKit, fragile heuristics for bundle detection, and potential race conditions in cleanup. Compared to `@content-collections/vite`, it lacks defensive patterns that established plugins include.

## Critical Issues

### 1. Missing `optimizeDeps` Exclusion
**Location:** `src/plugin.ts:69-82`

Unlike `@content-collections/vite` (lines 52-54), this plugin doesn't exclude `@usedocks/content` from Vite's dependency optimization:

```typescript
// Missing from config() hook:
optimizeDeps: {
  exclude: ["@usedocks/content"],
}
```

**Impact:** Vite may pre-bundle the virtual content module during development, causing stale data, "module not found" errors after regeneration, and inconsistent behavior between cold starts and HMR updates. This is a common source of confusing bugs in content-heavy applications.

### 2. Race Condition in Watch Handle Cleanup
**Location:** `src/plugin.ts:156-158`

```typescript
server.httpServer?.on("close", () => {
  watchHandle?.close();  // Async call without await
});
```

The `watchHandle.close()` returns a `Promise<void>` but is called without `await`. While `closeBundle` does await it (line 238), the server close handler doesn't wait. This can cause:
- Orphaned file watchers if the process terminates quickly
- Potential file handle leaks
- Dangling chokidar watchers consuming resources

### 3. No `server.fs.allow` Configuration
**Location:** `src/plugin.ts:69-82`

Frameworks like SvelteKit use strict `server.fs.allow` configurations. The plugin doesn't add the output directory:

```typescript
// Content-collections does this (lines 62-69 in their plugin):
if ((config.server?.fs?.allow || []).length > 0) {
  configPatch.server = {
    fs: {
      allow: [directory],
    },
  };
}
```

**Impact:** SvelteKit and other strict frameworks will fail with `403 Forbidden` errors when trying to serve generated content.

## Open Source Opportunities

### 1. Replace URL Pattern Matching with `URLPattern`
**Current:** Hand-rolled regex `/^\/([^/]+)\/(.+)\.md$/` (line 106)
**Alternative:** Native [`URLPattern`](https://developer.mozilla.org/en-US/docs/Web/API/URLPattern) API (Node.js 20+) or [`path-to-regexp`](https://github.com/pillarjs/path-to-regexp)

The current regex doesn't handle:
- URL-encoded characters (`%20` for spaces)
- Query strings (`?foo=bar`)
- Hash fragments (`#section`)

```typescript
// With URLPattern (standard API)
const pattern = new URLPattern({ pathname: '/:collection/:slug.md' });
const match = pattern.exec(url);
```

### 2. Use `defu` for Options Merging
**Current:** Manual spread with defaults (line 169)
**Alternative:** [`defu`](https://github.com/unjs/defu) from UnJS ecosystem

```typescript
// Current
const limits = bundleSize === true ? DEFAULT_BUNDLE_LIMITS : { ...DEFAULT_BUNDLE_LIMITS, ...bundleSize };

// With defu (handles nested objects properly)
import { defu } from 'defu';
const limits = defu(bundleSize === true ? {} : bundleSize, DEFAULT_BUNDLE_LIMITS);
```

### 3. Bundle Analysis via Rollup Metadata
**Current:** String-based package detection scans minified code (lines 177-185)
**Alternative:** Use Rollup's `chunk.moduleIds` for accurate module tracking

The current approach is unreliable:
```typescript
// Scans minified code for package names - false positives possible
if (chunk.code.includes(pkg)) {
  errors.push(`Banned package "${pkg}" found...`);
}
```

Better: Use `chunk.moduleIds` which contains the actual module paths resolved by Rollup.

### 4. Consider `consola` for Logging
**Current:** Mixed `console.log` and `server.config.logger.error` (lines 52, 149)
**Alternative:** [`consola`](https://github.com/unjs/consola) for consistent, environment-aware logging

## Edge Cases & Error Handling

### 1. Raw Markdown Middleware Error During Startup
**Location:** `src/plugin.ts:115-130`

```typescript
try {
  const mod = await server.ssrLoadModule("@usedocks/content");
  // ...
} catch (e) {
  log("[rawMarkdown]", e);
  // Fall through to 404
}
```

If `@usedocks/content` isn't generated yet (e.g., first request before `buildStart` completes), the module load fails silently. The error is logged only if `debug: true`, otherwise users see unexplained 404s.

### 2. No `isEnabled` Option for Multi-Build Scenarios
**Reference:** `@content-collections/vite` has `isEnabled?: (config: UserConfig) => boolean` (lines 8, 29-31)

Vite frameworks often run multiple builds (client/server/SSR). Without an `isEnabled` check, the plugin regenerates content redundantly for each build, wasting time and potentially causing race conditions.

### 3. Client Build Detection Heuristic is Fragile
**Location:** `src/plugin.ts:163`

```typescript
const isClientBuild = options.dir?.includes("/client") ?? false;
```

This fails for:
- Custom output directories
- SvelteKit (uses `.svelte-kit/output/client`)
- Astro, Remix, and other frameworks with different naming
- Windows paths (should normalize separators)

### 4. Main Bundle Detection is Unreliable
**Location:** `src/plugin.ts:200-203`

```typescript
if (fileName.includes("main-") || fileName.includes("index-")) {
  if (sizeKB > mainSize) mainSize = sizeKB;
}
```

This heuristic breaks for:
- SvelteKit: `_app/immutable/entry/start.[hash].js`
- Astro: `hoisted.[hash].js`
- Custom Rollup configurations

Better approach: Check `chunk.isEntry` which is a reliable indicator from Rollup.

### 5. Banned Package Detection False Positives
**Location:** `src/plugin.ts:180-184`

String matching on minified code can match:
- Comments containing the package name
- String literals (e.g., error messages mentioning the package)
- Mangled variable names that happen to contain the string

### 6. No Handling for Initial Generation Failure
**Location:** `src/plugin.ts:89-93`

```typescript
async buildStart() {
  const result = await generate(baseOptions);
  // If generate() throws, error bubbles up without context
}
```

Consider wrapping with a more descriptive error message.

## Code Quality Issues

### 1. Inconsistent Logging Mechanisms
The plugin uses three different logging approaches:
- Custom `log()` function using `console.log` (line 52)
- Vite's logger via `server.config.logger.error()` (line 149)
- Direct `console.log()` for bundle size reports (line 221)

This creates inconsistent output formatting and doesn't integrate with Vite's `--logLevel` flag.

### 2. Double Cleanup Paths
**Locations:** `src/plugin.ts:156-158` and `src/plugin.ts:237-239`

Both `configureServer` (via httpServer close event) and `closeBundle` attempt to close the watch handle. The nullish check (`?.`) prevents crashes, but the cleanup responsibility is unclear.

### 3. Type Assertion on Module Load
**Location:** `src/plugin.ts:117-119`

```typescript
const mod = await server.ssrLoadModule("@usedocks/content") as {
  getEntry: (collection: string, slug: string) => { content?: string } | undefined;
};
```

This assertion silently allows mismatched types at runtime. Consider runtime validation or importing the type from a shared location.

### 4. Non-null Assertions in Pattern Match
**Location:** `src/plugin.ts:111, 120`

```typescript
if (allowedCollections && !allowedCollections.includes(collection!)) {
const entry = mod.getEntry(collection!, slug!);
```

The regex guarantees these are defined if `match` exists, but non-null assertions obscure intent. Destructuring with explicit checks would be clearer.

### 5. Test Coverage is Minimal
**Location:** `src/__tests__/plugin.test.ts`

Current 42-line test file only verifies:
- Plugin name is "docks"
- Required hooks exist
- Options are accepted

Missing tests for:
- Content generation in `buildStart`
- Watch mode and HMR triggers
- Raw markdown middleware responses
- Bundle size checking logic
- Error scenarios
- Cleanup behavior

## Architecture Concerns

### 1. Plugin State in Closure
**Location:** `src/plugin.ts:48-49`

```typescript
let watchHandle: WatchHandle | null = null;
let resolvedOutDir: string;
```

Mutable state in closure makes the plugin non-reusable. If the same plugin instance were used in multiple Vite instances, state would be shared incorrectly.

### 2. Monolithic Plugin Structure
The plugin handles three distinct concerns in one function:
- Core content generation and watching
- Raw markdown middleware
- Bundle size checking

These could be split into composable plugins:
```typescript
export function docks(options) {
  return [
    docksCore(options),
    options.rawMarkdown && docksRawMarkdown(options.rawMarkdown),
    options.bundleSize && docksBundleCheck(options.bundleSize),
  ].filter(Boolean);
}
```

### 3. Lifecycle Hook Dependencies
The plugin has implicit ordering dependencies between hooks:
1. `config` sets up initial `resolvedOutDir`
2. `configResolved` updates it with final value
3. Other hooks use it

If hook ordering changes or a hook is skipped, things could break silently.

### 4. Full-Page Reload Instead of Granular HMR
**Location:** `src/plugin.ts:146`

```typescript
server.ws.send({ type: "full-reload" });
```

Every content change triggers a full page reload. For large applications, this is unnecessarily disruptive. The `handleHotUpdate` hook could enable granular updates for affected modules only.

## Recommendations

### Priority 1: Critical Fixes
1. Add `optimizeDeps.exclude` for `@usedocks/content` in `config` hook
2. Add `server.fs.allow` for strict framework support (SvelteKit, etc.)
3. Fix async cleanup in server close handler (await the close promise)
4. Wrap `generate()` call in `buildStart` with descriptive error handling

### Priority 2: Robustness Improvements
5. Add `isEnabled` option to prevent redundant builds
6. Replace string-based bundle detection with `chunk.isEntry` and `chunk.moduleIds`
7. Use proper URL parsing for raw markdown routes
8. Add runtime type checking when loading `@usedocks/content` module

### Priority 3: Code Quality
9. Unify logging to use Vite's logger consistently
10. Add comprehensive integration tests
11. Document magic constants (why 400KB/500KB limits?)
12. Separate dev/build cleanup paths clearly

### Priority 4: Future Enhancements
13. Split into composable plugins for flexibility
14. Implement granular HMR via `handleHotUpdate` hook
15. Support configurable URL patterns via `path-to-regexp`
16. Consider virtual module pattern instead of file aliases

---

## Shared Package Resolution

*Updated: 2026-01-06*

The following issues from this review are addressed by `@usedocks/shared`:

| Original Issue | Shared Solution | Status |
|----------------|-----------------|--------|
| Race condition in watch handle cleanup (async close without await) | `@usedocks/shared/shutdown` - `GracefulShutdown` | Resolved |
| Missing graceful shutdown patterns | `@usedocks/shared/shutdown` - `GracefulShutdown.setupSignalHandlers()` | Resolved |

### Migration Required

To resolve the issues marked above:

1. Add `@usedocks/shared` to this package's dependencies:
   ```bash
   pnpm add @usedocks/shared
   ```

2. Update imports:
   ```typescript
   // Replace ad-hoc cleanup with:
   import { GracefulShutdown } from "@usedocks/shared/shutdown";
   ```

3. Files to modify:
   - `src/plugin.ts` - Replace manual cleanup in `configureServer` (lines 156-158) and `closeBundle` (lines 237-239) with `GracefulShutdown` instance that properly awaits async cleanup operations

### Implementation Example

```typescript
// In plugin.ts
import { GracefulShutdown } from "@usedocks/shared/shutdown";

export function docks(options: DocksOptions): Plugin {
  let watchHandle: WatchHandle | null = null;
  let resolvedOutDir: string;
  const shutdown = new GracefulShutdown();

  // Register cleanup
  shutdown.onShutdown(async () => {
    if (watchHandle) {
      await watchHandle.close();
      watchHandle = null;
    }
  });

  return {
    // ...
    configureServer(server) {
      server.httpServer?.on("close", async () => {
        await shutdown.shutdown();
      });
    },
    async closeBundle() {
      await shutdown.shutdown();
    }
  };
}
```

### Remaining Issues

The following issues require package-specific fixes:

**Critical:**
- Missing `optimizeDeps.exclude` for `@usedocks/content` in `config` hook
- No `server.fs.allow` configuration for strict frameworks (SvelteKit)

**Robustness:**
- URL pattern matching uses hand-rolled regex instead of `URLPattern` or `path-to-regexp`
- Bundle analysis uses string-based package detection (false positives)
- Client build detection heuristic is fragile (line 163)
- Main bundle detection unreliable - should use `chunk.isEntry`
- Banned package detection has false positives from minified code matching
- No `isEnabled` option for multi-build scenarios
- Raw markdown middleware silently fails if content not generated yet

**Code Quality:**
- Inconsistent logging mechanisms (custom `log()`, Vite logger, direct `console.log`)
- Double cleanup paths in `configureServer` and `closeBundle`
- Type assertion on module load without runtime validation
- Non-null assertions in pattern match obscure intent
- Minimal test coverage (42 lines)

**Architecture:**
- Plugin state in closure makes it non-reusable across multiple Vite instances
- Monolithic plugin structure handles three distinct concerns
- Full-page reload instead of granular HMR via `handleHotUpdate`
- Implicit lifecycle hook dependencies
