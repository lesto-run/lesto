import path from "node:path";
import {
  generate,
  watch,
  type GenerateResult,
  type WatchHandle,
  type WatchOptions,
} from "@volo/content-core/build";
import type { Plugin, ResolvedConfig, ViteDevServer, UserConfig, Rollup } from "vite";

export interface RawMarkdownOptions {
  /** Collections to serve raw markdown for. Default: all collections */
  collections?: string[];
  /** URL pattern. Default: "/:collection/:slug.md" */
  pattern?: string;
}

export interface BundleSizeLimit {
  /** Max size in KB for the main client bundle */
  clientMain?: number;
  /** Max total size in KB for all client JS */
  clientTotal?: number;
  /** Fail build if limits exceeded. Default: true in CI, false otherwise */
  failOnExceed?: boolean;
  /** Packages that should never appear in client bundle */
  bannedPackages?: string[];
}

export interface DocksPluginOptions {
  /** Enable debug logging */
  debug?: boolean;
  /** Custom output directory */
  outDir?: string;
  /**
   * Serve raw markdown files at /collection/slug.md
   * Set to true for all collections, or configure per-collection.
   */
  rawMarkdown?: boolean | RawMarkdownOptions;
  /**
   * Bundle size limits. Warns or fails build if exceeded.
   * Set to true for sensible defaults (400KB client main, 500KB total).
   */
  bundleSize?: boolean | BundleSizeLimit;
}

const DEFAULT_BUNDLE_LIMITS: Required<Omit<BundleSizeLimit, "failOnExceed">> = {
  clientMain: 400,
  clientTotal: 500,
  bannedPackages: ["@volo/content-core"],
};

export function docks(options: DocksPluginOptions = {}): Plugin {
  const { debug = false, outDir, rawMarkdown, bundleSize } = options;
  let watchHandle: WatchHandle | null = null;
  let resolvedOutDir: string;

  const log = (...args: unknown[]) => {
    if (debug) console.log("[docks]", ...args);
  };

  // Normalize rawMarkdown options
  const rawMarkdownConfig: RawMarkdownOptions | null = rawMarkdown
    ? typeof rawMarkdown === "boolean"
      ? {}
      : rawMarkdown
    : null;

  // Build options object, only including outDir if it's defined
  const baseOptions: { outDir?: string; verbose: boolean } = { verbose: debug };
  if (outDir !== undefined) baseOptions.outDir = outDir;

  return {
    name: "docks",

    config(config: UserConfig) {
      // Configure @volo/content-content alias to point to generated directory
      // This works alongside tsconfig paths for TypeScript
      const root = config.root ?? process.cwd();
      resolvedOutDir = outDir ?? path.join(root, ".docks", "generated");

      // Build config patch
      const configPatch: Partial<UserConfig> = {
        resolve: {
          alias: {
            "@volo/content-content": resolvedOutDir,
          },
        },
        // Exclude @volo/content-content from Vite's dependency optimization
        // to prevent stale data after content regeneration
        optimizeDeps: {
          exclude: ["@volo/content-content"],
        },
      };

      // Add server.fs.allow for strict frameworks like SvelteKit
      // Only add if fs.allow is already configured (to respect user settings)
      if ((config.server?.fs?.allow || []).length > 0) {
        configPatch.server = {
          fs: {
            allow: [resolvedOutDir],
          },
        };
      }

      return configPatch;
    },

    configResolved(config: ResolvedConfig) {
      // Update resolvedOutDir in case it was overridden
      resolvedOutDir = outDir ?? path.join(config.root, ".docks", "generated");
    },

    async buildStart() {
      log("Generating content...");
      try {
        const result = await generate(baseOptions);
        log(`Generated ${result.entryCount} entries in ${result.duration.toFixed(0)}ms`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`[docks] Failed to generate content: ${message}`, { cause: error });
      }
    },

    configureServer(server: ViteDevServer) {
      log("Starting watch mode...");

      // Add rawMarkdown middleware if enabled
      if (rawMarkdownConfig) {
        const { collections: allowedCollections } = rawMarkdownConfig;

        // Connect/Vite middleware must stay synchronous: an async handler that
        // rejects becomes an unhandled rejection. Run the async work in an inner
        // function and forward any failure to `next`.
        server.middlewares.use((req, res, next) => {
          const handle = async (): Promise<void> => {
            const url = req.url || "";

            // Match pattern: /collection/slug.md
            const match = url.match(/^\/([^/]+)\/(.+)\.md$/);
            if (!match) {
              next();
              return;
            }

            const [, collection, slug] = match;

            // Check if collection is allowed (if configured)
            if (allowedCollections && !allowedCollections.includes(collection!)) {
              next();
              return;
            }

            try {
              // Use Vite's ssrLoadModule to properly resolve the alias
              const mod = (await server.ssrLoadModule("@volo/content-content")) as {
                getEntry: (collection: string, slug: string) => { content?: string } | undefined;
              };
              const entry = mod.getEntry(collection!, slug!);

              if (entry?.content) {
                res.setHeader("Content-Type", "text/plain; charset=utf-8");
                res.end(entry.content);
                return;
              }
            } catch (e) {
              log("[rawMarkdown]", e);
              // Fall through to 404
            }

            res.statusCode = 404;
            res.end("Not found");
          };

          // The expected failure (a module that won't load) is handled inside
          // `handle` and falls through to 404; this guards the unexpected.
          handle().catch((error: unknown) => {
            log("[rawMarkdown]", error);
            if (!res.writableEnded) {
              res.statusCode = 500;
              res.end("Internal Server Error");
            }
          });
        });
      }

      const watchOptions: WatchOptions = {
        ...baseOptions,
        onGenerate: (result: GenerateResult) => {
          log(`Regenerated ${result.entryCount} entries`);
          // Trigger HMR
          server.ws.send({ type: "full-reload" });
        },
        onError: (error: Error) => {
          server.config.logger.error(`[docks] ${error.message}`);
        },
      };

      watchHandle = watch(watchOptions);

      // Cleanup on server close - properly await async close
      server.httpServer?.on("close", async () => {
        if (watchHandle) {
          await watchHandle.close();
          watchHandle = null;
        }
      });
    },

    writeBundle(outputOptions: Rollup.NormalizedOutputOptions, bundle: Rollup.OutputBundle) {
      // Detect client build by output directory (client builds go to dist/client)
      const isClientBuild = outputOptions.dir?.includes("/client") ?? false;

      // Only check client bundles
      if (!isClientBuild || !bundleSize) return;

      const limits: BundleSizeLimit =
        bundleSize === true ? DEFAULT_BUNDLE_LIMITS : { ...DEFAULT_BUNDLE_LIMITS, ...bundleSize };

      // CI detection: most CI systems set CI=true, but some use CI=1
      const isCI = !!process.env["CI"];
      const shouldFail = limits.failOnExceed ?? isCI;
      const errors: string[] = [];

      // Check for banned packages in bundle using moduleIds for accurate detection
      if (limits.bannedPackages && limits.bannedPackages.length > 0) {
        for (const [fileName, chunk] of Object.entries(bundle)) {
          if (chunk.type !== "chunk") continue;
          // Use moduleIds for accurate package detection (avoids false positives from minified code)
          const moduleIds = chunk.moduleIds || [];
          for (const pkg of limits.bannedPackages) {
            // Check if any module comes from the banned package
            const found = moduleIds.some(
              (id) =>
                id.includes(`/node_modules/${pkg}/`) || id.includes(`\\node_modules\\${pkg}\\`),
            );
            if (found) {
              errors.push(`Banned package "${pkg}" found in ${fileName}`);
            }
          }
        }
      }

      // Calculate bundle sizes
      let mainSize = 0;
      let totalSize = 0;

      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type !== "chunk") continue;
        // Include both .js and .mjs files
        if (!fileName.endsWith(".js") && !fileName.endsWith(".mjs")) continue;

        const sizeKB = Buffer.byteLength(chunk.code, "utf8") / 1024;
        totalSize += sizeKB;

        // Use Rollup's isEntry flag for reliable entry point detection
        // Falls back to filename heuristics for compatibility with older tools
        if (chunk.isEntry || fileName.includes("main-") || fileName.includes("index-")) {
          if (sizeKB > mainSize) mainSize = sizeKB;
        }
      }

      // Check limits
      if (limits.clientMain && mainSize > limits.clientMain) {
        errors.push(
          `Client main bundle (${mainSize.toFixed(1)}KB) exceeds limit (${limits.clientMain}KB)`,
        );
      }

      if (limits.clientTotal && totalSize > limits.clientTotal) {
        errors.push(
          `Client total (${totalSize.toFixed(1)}KB) exceeds limit (${limits.clientTotal}KB)`,
        );
      }

      // Report results
      if (errors.length > 0) {
        console.log(`\n[docks] Bundle size check ${shouldFail ? "FAILED" : "WARNING"}:`);
        for (const error of errors) {
          console.log(`  - ${error}`);
        }
        console.log("");

        if (shouldFail) {
          throw new Error("Bundle size limits exceeded");
        }
      } else {
        const mainLimit = limits.clientMain ?? DEFAULT_BUNDLE_LIMITS.clientMain;
        const totalLimit = limits.clientTotal ?? DEFAULT_BUNDLE_LIMITS.clientTotal;
        log(
          `Bundle check OK: main=${mainSize.toFixed(1)}KB (limit: ${mainLimit}KB), total=${totalSize.toFixed(1)}KB (limit: ${totalLimit}KB)`,
        );
      }
    },

    async closeBundle() {
      if (watchHandle) {
        await watchHandle.close();
        watchHandle = null;
      }
    },
  };
}
