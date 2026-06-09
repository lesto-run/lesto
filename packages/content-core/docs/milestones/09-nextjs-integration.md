# Milestone 9: Next.js Integration

## Objective
Update @usedocks/next plugin to use the new pipeline architecture.

## Dependencies
- Milestone 8 (engine)

## Deliverables
- [ ] `plugin.ts` - Simplified plugin using pipeline
- [ ] Delete `loader.ts` (no more legacy import mechanism)
- [ ] Update `index.ts` exports
- [ ] Tests for plugin

## Files to Modify

### `packages/next/src/plugin.ts` (Simplify)

```typescript
import path from "node:path";
import type { NextConfig } from "next";
import type { Configuration as WebpackConfig, Compiler } from "webpack";
import { createEngine, type Engine, type EngineConfig } from "@usedocks/core";

const PLUGIN_NAME = "DocksPlugin";

const SERVER_EXTERNAL_PACKAGES = [
  "@usedocks/core",
  "@usedocks/next",
  "jiti",
] as const;

export interface DocksNextConfig extends Partial<EngineConfig> {
  /** Enable debug logging */
  debug?: boolean;
}

interface WebpackContext {
  dev: boolean;
  isServer: boolean;
  dir: string;
}

// Global engine instance (shared across compilations)
let engine: Engine | null = null;

function log(debug: boolean, ...args: unknown[]): void {
  if (debug) console.log("[docks]", ...args);
}

/**
 * Wrap a Next.js config with Docks content collection support.
 */
export function withDocks(
  nextConfig: NextConfig = {},
  docksConfig: DocksNextConfig = {}
): NextConfig {
  const { debug = false, ...engineConfig } = docksConfig;

  return {
    ...nextConfig,

    webpack(config: WebpackConfig, context: WebpackContext) {
      const { dev, dir, isServer } = context;

      log(debug, `Configuring webpack (dev=${dev}, server=${isServer})`);

      config.plugins ??= [];

      // Server externalization
      if (isServer) {
        const externals = config.externals;
        if (!externals) {
          config.externals = [...SERVER_EXTERNAL_PACKAGES];
        } else if (Array.isArray(externals)) {
          for (const pkg of SERVER_EXTERNAL_PACKAGES) {
            if (!externals.includes(pkg)) {
              externals.push(pkg);
            }
          }
        }
      }

      config.plugins.push({
        name: PLUGIN_NAME,
        apply(compiler: Compiler) {
          // Initialize engine and generate types before compilation
          compiler.hooks.beforeCompile.tapPromise(PLUGIN_NAME, async () => {
            log(debug, "Initializing engine...");

            try {
              const fullConfig: EngineConfig = {
                cwd: dir,
                ...engineConfig,
              };

              // Create or reuse engine
              if (!engine) {
                engine = createEngine(fullConfig);
              }

              await engine.scan();

              // Write types
              const typesPath = await engine.writeTypes(
                path.join(dir, ".docks")
              );
              log(debug, `Types written to: ${typesPath}`);
            } catch (error) {
              console.error("[docks] Failed to initialize:", error);
              throw error;
            }
          });

          // Re-scan on watch
          if (dev) {
            compiler.hooks.watchRun.tapPromise(PLUGIN_NAME, async () => {
              if (!engine) return;

              try {
                await engine.scan();
                await engine.writeTypes(path.join(dir, ".docks"));
                log(debug, "Content updated");
              } catch (error) {
                console.warn("[docks] Watch update failed:", error);
              }
            });
          }

          // Cleanup
          compiler.hooks.shutdown.tap(PLUGIN_NAME, () => {
            log(debug, "Shutting down");
            engine = null;
          });
        },
      });

      // Run user's webpack config
      if (typeof nextConfig.webpack === "function") {
        return nextConfig.webpack(
          config,
          context as Parameters<NonNullable<NextConfig["webpack"]>>[1]
        );
      }

      return config;
    },

    serverExternalPackages: [
      ...(nextConfig.serverExternalPackages ?? []),
      ...SERVER_EXTERNAL_PACKAGES,
    ],
  };
}

/**
 * Get the current engine instance (for advanced use cases).
 */
export function getEngine(): Engine | null {
  return engine;
}

/**
 * Invalidate the engine instance.
 */
export function invalidateEngine(): void {
  engine = null;
}
```

### `packages/next/src/index.ts` (Update)

```typescript
// Plugin
export { withDocks, getEngine, invalidateEngine } from "./plugin";
export type { DocksNextConfig } from "./plugin";

// Re-export from @usedocks/core
export {
  // Config
  defineCollection,
  defineConfig,

  // Runtime API
  getEntry,
  getCollection,
  getCollections,
  getRuntimeEngine,
  setRuntimeConfig,
  invalidateRuntimeEngine,

  // Pipeline (advanced)
  runPipeline,
  pipeline,
  createEngine,

  // Errors
  ValidationError,
  TransformError,
} from "@usedocks/core";

// Re-export types
export type {
  AnyCollection,
  Collection,
  CollectionConfig,
  CollectionData,
  CollectionRegistry,
  CollectionSchema,
  CollectionTransformed,
  Document,
  DocumentMeta,
  Engine,
  EngineConfig,
  Entry,
  InferEntry,
  InferOutput,
  PipelineOptions,
  PipelineResult,
  TransformContext,
  TransformFn,
  ValidationIssue,
  ValidationMode,
  WatchCallback,
  WatchEvent,
} from "@usedocks/core";
```

### Delete Files

- `packages/next/src/loader.ts` - No longer needed
- `packages/next/src/engine-store.ts` - Replaced by simplified plugin
- `packages/next/src/constants.ts` - No longer needed
- `packages/next/src/utils.ts` - Inline what's needed

## Tests

```typescript
// packages/next/src/__tests__/plugin.test.ts
import { describe, it, expect } from "vitest";
import { withDocks } from "../plugin";

describe("withDocks", () => {
  it("returns a next config", () => {
    const config = withDocks({});
    expect(config).toBeDefined();
    expect(typeof config.webpack).toBe("function");
  });

  it("preserves existing config", () => {
    const config = withDocks({
      reactStrictMode: true,
    });
    expect(config.reactStrictMode).toBe(true);
  });

  it("adds server external packages", () => {
    const config = withDocks({});
    expect(config.serverExternalPackages).toContain("@usedocks/core");
    expect(config.serverExternalPackages).toContain("@usedocks/next");
  });

  it("merges with existing external packages", () => {
    const config = withDocks({
      serverExternalPackages: ["other-package"],
    });
    expect(config.serverExternalPackages).toContain("other-package");
    expect(config.serverExternalPackages).toContain("@usedocks/core");
  });
});
```

## Acceptance Criteria

- [ ] Plugin uses createEngine from @usedocks/core
- [ ] Types are written to .docks directory
- [ ] Watch mode re-scans on changes
- [ ] No more legacy module-interception handling
- [ ] Server externalization works
- [ ] All re-exports work correctly
- [ ] All tests pass

## Notes

- Legacy module-based import mechanism is removed
- Users import everything from `@usedocks/core` or `@usedocks/next`
- Types are generated to `.docks/types.d.ts` and included via tsconfig
