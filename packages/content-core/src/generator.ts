import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import serialize from "serialize-javascript";
import { AsyncMutex } from "@volo/content-shared/mutex";
import { resolveConfig } from "./config";
import { createEngine } from "./engine";
import { generateTypes } from "./typegen";
import { clearRendererCache } from "./transformer";
import type { RuntimeEntry, AnyCollection, OutputConfig } from "./types";
import type { AnyTaxonomy } from "./taxonomy";
import { isImportReference, ImportCollector, type AnyImportReference } from "./imports";
import type { CacheOptions } from "./cache";
import { toSafeKey } from "./utils";
import type { EventEmitter } from "./events";

// ============================================================================
// Types
// ============================================================================

export interface GenerateOptions {
  /** Working directory containing docks.config.{ts,js,mjs}. Defaults to process.cwd() */
  cwd?: string;

  /** Output directory for generated files. Defaults to `${cwd}/.docks/generated` */
  outDir?: string;

  /** Also write types to node_modules/.docks for IDE support. Defaults to true */
  writeNodeModulesTypes?: boolean;

  /** Delete output directory before generating. Defaults to true */
  clean?: boolean;

  /** Log generation progress. Defaults to false */
  verbose?: boolean;

  /** Programmatic collections config (bypasses config file). */
  collections?: AnyCollection[];

  /** Programmatic taxonomies config (bypasses config file). */
  taxonomies?: AnyTaxonomy[];

  /** Cache options for faster incremental builds */
  cache?: CacheOptions;

  /**
   * Build event emitter. When provided, generate() emits build lifecycle events
   * (build:start, build:end, build:error) so tooling can observe the build.
   */
  events?: EventEmitter;

  /** Called after successful generation. Runs before returning from generate(). */
  onSuccess?: (result: GenerateResult) => void | Promise<void>;
}

export interface GenerateResult {
  /** Absolute path to output directory */
  outDir: string;

  /** Names of generated collections */
  collections: string[];

  /** Total number of entries across all collections */
  entryCount: number;

  /** Absolute path to generated types.d.ts */
  typesPath: string;

  /** Absolute path to generated index.js */
  indexPath: string;

  /** Time taken in milliseconds */
  duration: number;
}

export interface WatchOptions extends GenerateOptions {
  /** Called after each successful regeneration */
  onGenerate?: (result: GenerateResult) => void;

  /** Called when an error occurs during regeneration */
  onError?: (error: Error) => void;

  /** Debounce delay in milliseconds. Defaults to 100 */
  debounce?: number;
}

export interface WatchHandle {
  /** Stop watching and clean up */
  close: () => Promise<void>;

  /** Manually trigger a regeneration */
  regenerate: () => Promise<GenerateResult>;
}

// ============================================================================
// Serialization
// ============================================================================

const IMPORT_PLACEHOLDER_PREFIX = "__DOCKS_IMPORT_";
const serializerCache = new Map<string, (obj: unknown) => string>();

/** @internal Clear all module-level caches to ensure fresh processing */
function clearInternalCaches(): void {
  clearRendererCache();
  serializerCache.clear();
}

/**
 * Recursively process an object to handle import references.
 * Dates are handled natively by serialize-javascript.
 */
function preprocessForSerialization(obj: unknown, collector: ImportCollector): unknown {
  if (obj === null || obj === undefined) return obj;
  if (obj instanceof Date) return obj; // serialize-javascript handles dates natively
  if (isImportReference(obj)) {
    const varName = collector.getVarName(obj as AnyImportReference);
    return `${IMPORT_PLACEHOLDER_PREFIX}${varName}`;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => preprocessForSerialization(item, collector));
  }
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = preprocessForSerialization(value, collector);
    }
    return result;
  }
  return obj;
}

/**
 * Replace import placeholders in serialized JSON with actual variable references.
 * Converts "\"__DOCKS_IMPORT___v_0\"" to __v_0 (unquoted).
 */
function replaceImportPlaceholders(serialized: string): string {
  const placeholderRegex = new RegExp(`"${IMPORT_PLACEHOLDER_PREFIX}(__v_\\d+)"`, "g");
  return serialized.replace(placeholderRegex, "$1");
}

/**
 * Apply output configuration to strip excluded fields from entries.
 */
function applyOutputConfig(entries: RuntimeEntry[], output?: OutputConfig): RuntimeEntry[] {
  if (!output || output.includeContent !== false) {
    return entries;
  }

  // Strip 'content' field from entries
  return entries.map((entry) => {
    const { content: _content, ...rest } = entry;
    return rest as RuntimeEntry;
  });
}

/**
 * Serialize entries to JavaScript module content.
 *
 * Uses serialize-javascript for proper JavaScript output that handles:
 * - Date -> new Date("...")
 * - undefined -> undefined (not stripped like JSON)
 * - Import references -> Variable references with import statements
 * - Functions -> excluded (not serializable)
 *
 * This eliminates the need for runtime revive() functions.
 */
function serializeEntries(entries: RuntimeEntry[], output?: OutputConfig): string {
  // Apply output configuration to strip excluded fields
  const processedEntries = applyOutputConfig(entries, output);
  const collector = new ImportCollector();
  const preprocessed = preprocessForSerialization(processedEntries, collector);

  // Use serialize-javascript for proper JS output with Date support
  // The 'unsafe' option outputs valid JS (not JSON-safe) which is what we want
  const space = process.env["NODE_ENV"] === "development" ? 2 : undefined;
  let serialized = serialize(preprocessed, { unsafe: true, space });

  if (collector.hasImports()) {
    serialized = replaceImportPlaceholders(serialized);
  }

  const importStatements = collector.hasImports()
    ? collector.generateImportStatements() + "\n\n"
    : "";

  return `// Generated by @volo/content-core - DO NOT EDIT
// This file contains pre-built content data for browser usage

${importStatements}const data = ${serialized};

export default data;
`;
}

/**
 * Generate the index.js that re-exports all collections.
 *
 * This generates self-contained code with NO external @usedocks imports.
 * Users should use standard JavaScript methods for filtering/searching:
 * - posts.find(p => p.slug === slug)
 * - posts.filter(p => p.featured)
 * - posts.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5)
 */
function generateIndex(collections: string[]): string {
  // A collection name is an arbitrary string (e.g. "blog-posts"), but it is used
  // both as a module-file basename and, naively, as a JS binding — and kebab-case
  // is not a valid identifier. Map every name to a safe, unique local binding and
  // re-export it under its real name (quoted when necessary) so ANY valid
  // collection name produces loadable JavaScript.
  const bindings = collections.map((name, index) => ({
    name,
    local: `__c_${index}`,
  }));

  const imports = bindings
    .map(({ name, local }) => `import ${local} from "./${name}.js";`)
    .join("\n");

  const exportSpecifiers = bindings
    .map(({ name, local }) => `${local} as ${toSafeKey(name)}`)
    .join(", ");

  const collectionEntries = bindings
    .map(({ name, local }) => `${toSafeKey(name)}: ${local}`)
    .join(", ");

  return `// Generated by @volo/content-core - DO NOT EDIT
// Use standard JavaScript for filtering/searching content:
//   posts.find(p => p.slug === slug)
//   posts.filter(p => p.featured)
//   posts.sort((a, b) => new Date(b.date) - new Date(a.date))
${imports}

export { ${exportSpecifiers} };

// Collection lookup helper (optional - you can import collections directly)
export const collections = { ${collectionEntries} };

/**
 * Get all entries in a collection.
 * @param {string} name - The collection name
 * @returns {Array} The collection entries
 */
export function getCollection(name) {
  return collections[name] ?? [];
}

/**
 * Get a single entry by collection name and slug.
 * @param {string} collection - The collection name
 * @param {string} slug - The entry slug
 * @returns {Object|undefined} The entry or undefined if not found
 */
export function getEntry(collection, slug) {
  const entries = collections[collection];
  return entries?.find((e) => e.slug === slug);
}
`;
}

/**
 * Generate TypeScript declarations for the generated data files.
 */
function generateDataTypes(collections: AnyCollection[]): string {
  const lines: string[] = [
    "// Generated by @volo/content-core - DO NOT EDIT",
    "",
    'import type { CollectionEntry, CollectionRegistry } from "@volo/content-core";',
    "",
  ];

  // Mirror generateIndex(): every collection is bound to a safe local name and
  // re-exported under its real (possibly kebab-case) name. The declarations MUST
  // match the runtime exports exactly or the .d.ts lies about the module shape.
  collections.forEach((col, index) => {
    lines.push(`declare const __c_${index}: CollectionEntry<"${col.name}">[];`);
  });
  // `export {}` / `export { ... }` is valid even with zero specifiers, so emit
  // unconditionally — no special-casing the empty list (keeps .d.ts and index.js
  // structurally identical).
  const specifiers = collections
    .map((col, index) => `__c_${index} as ${toSafeKey(col.name)}`)
    .join(", ");
  lines.push(`export { ${specifiers} };`);

  lines.push("");
  lines.push("export declare const collections: {");
  for (const col of collections) {
    lines.push(`  ${toSafeKey(col.name)}: CollectionEntry<"${col.name}">[];`);
  }
  lines.push("};");
  lines.push("");

  // Add typed helper function declarations
  lines.push("/**");
  lines.push(" * Get all entries in a collection.");
  lines.push(" */");
  lines.push("export declare function getCollection<K extends keyof CollectionRegistry>(");
  lines.push("  name: K,");
  lines.push("): CollectionEntry<K>[];");
  lines.push("");
  lines.push("/**");
  lines.push(" * Get a single entry by collection name and slug.");
  lines.push(" */");
  lines.push("export declare function getEntry<K extends keyof CollectionRegistry>(");
  lines.push("  collection: K,");
  lines.push("  slug: string,");
  lines.push("): CollectionEntry<K> | undefined;");
  lines.push("");

  return lines.join("\n");
}

// ============================================================================
// Generator
// ============================================================================

export async function generate(options: GenerateOptions = {}): Promise<GenerateResult> {
  const start = performance.now();
  const cwd = options.cwd ?? process.cwd();
  const outDir = options.outDir ?? path.join(cwd, ".docks", "generated");
  const writeNodeModulesTypes = options.writeNodeModulesTypes ?? true;
  const verbose = options.verbose ?? false;

  const log = (...args: unknown[]) => {
    if (verbose) console.log("[docks]", ...args);
  };

  // Clear module-level caches to ensure fresh processing on each build
  clearInternalCaches();

  // Clean output directory
  if (options.clean !== false) {
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
  await mkdir(outDir, { recursive: true });

  log("Resolving config...");
  let collections: AnyCollection[];
  let taxonomies: AnyTaxonomy[] = [];
  let configPath: string | null = null;

  if (options.collections && options.collections.length > 0) {
    // Use programmatic collections
    collections = options.collections;
    taxonomies = options.taxonomies ?? [];
  } else {
    // Load from config file
    const config = await resolveConfig(cwd);
    collections = config.collections;
    taxonomies = config.taxonomies;
    configPath = config.configPath;
  }

  // Build lifecycle events let tooling observe the build. Emitted here so the
  // generate() entry point — the framework's real build path — actually drives
  // the event taxonomy rather than leaving it inert.
  const events = options.events;
  await events?.emit("build:start", { cwd, collectionCount: collections.length });

  try {
    return await runGeneration();
  } catch (error) {
    await events?.emit("build:error", { error: error as Error });
    throw error;
  }

  async function runGeneration(): Promise<GenerateResult> {
    log("Creating engine...");
    const engine = createEngine({
      collections,
      taxonomies,
      cwd,
      ...(options.cache !== undefined && { cache: options.cache }),
    });
    await engine.scan();

    // Collections that actually produced entries (public GenerateResult.collections).
    const nonEmptyCollectionNames: string[] = [];
    let entryCount = 0;
    const writePromises: Promise<void>[] = [];

    // Index over entries that actually exist so empty collections still resolve.
    const entriesByName = new Map(engine.getCollections().map((col) => [col.name, col.entries]));

    // INVARIANT: the generated index.js MUST export every collection that the
    // generated index.d.ts declares — otherwise the types lie and importing the
    // module throws at load time (the .d.ts is built from the full configured
    // list, so the .js must be too). We emit a data file (an empty array when
    // there are no entries) for EVERY configured collection, not just the ones
    // the engine happened to find files for.
    for (const colConfig of collections) {
      const entries = entriesByName.get(colConfig.name) ?? [];
      log(`Generating ${colConfig.name} (${entries.length} entries)...`);
      const content = serializeEntries(entries, colConfig.output);
      writePromises.push(writeFile(path.join(outDir, `${colConfig.name}.js`), content, "utf-8"));
      if (entries.length > 0) {
        nonEmptyCollectionNames.push(colConfig.name);
      }
      entryCount += entries.length;
    }

    // index.js / index.d.ts cover all configured collections so the two agree.
    const allCollectionNames = collections.map((c) => c.name);
    const indexContent = generateIndex(allCollectionNames);
    const indexPath = path.join(outDir, "index.js");
    const dataTypesContent = generateDataTypes(collections);

    // Calculate relative path from output directory to config for type imports
    // Config: /path/to/project/docks.config.ts
    // OutDir: /path/to/project/.docks/generated/
    // Relative: ../../docks.config (without extension)
    let relativeConfigPath: string | undefined;
    if (configPath) {
      const relativePath = path.relative(outDir, configPath);
      // Convert to posix path and remove extension for TypeScript import
      relativeConfigPath = relativePath
        .split(path.sep)
        .join("/")
        .replace(/\.(ts|js|mjs)$/, "");
      // Ensure it starts with ./ or ../
      if (!relativeConfigPath.startsWith(".")) {
        relativeConfigPath = "./" + relativeConfigPath;
      }
    }

    const moduleTypesContent = generateTypes(
      collections,
      taxonomies,
      relativeConfigPath === undefined ? {} : { configPath: relativeConfigPath },
    );
    const typesPath = path.join(outDir, "types.d.ts");

    writePromises.push(
      writeFile(indexPath, indexContent, "utf-8"),
      writeFile(path.join(outDir, "index.d.ts"), dataTypesContent, "utf-8"),
      writeFile(typesPath, moduleTypesContent, "utf-8"),
    );

    await Promise.all(writePromises);

    // Also write to node_modules for IDE support
    if (writeNodeModulesTypes) {
      const nodeModulesDir = path.join(cwd, "node_modules", ".docks");
      await mkdir(nodeModulesDir, { recursive: true });
      await writeFile(path.join(nodeModulesDir, "types.d.ts"), moduleTypesContent, "utf-8");
    }

    const duration = performance.now() - start;
    log(`Generated ${entryCount} entries in ${duration.toFixed(0)}ms`);

    const result: GenerateResult = {
      outDir,
      collections: nonEmptyCollectionNames,
      entryCount,
      typesPath,
      indexPath,
      duration,
    };

    await events?.emit("build:end", {
      duration,
      entryCount,
      collections: nonEmptyCollectionNames,
    });

    if (options.onSuccess) {
      await options.onSuccess(result);
    }

    return result;
  }
}

// ============================================================================
// Watcher
// ============================================================================

export function watch(options: WatchOptions = {}): WatchHandle {
  const cwd = options.cwd ?? process.cwd();
  const outDir = options.outDir ?? path.join(cwd, ".docks", "generated");
  const writeNodeModulesTypes = options.writeNodeModulesTypes ?? true;
  const verbose = options.verbose ?? false;
  const debounceMs = options.debounce ?? 100;

  const log = (...args: unknown[]) => {
    if (verbose) console.log("[docks]", ...args);
  };

  let engine: ReturnType<typeof createEngine> | null = null;
  let engineUnwatch: (() => void) | null = null;
  let collections: AnyCollection[] = [];
  let taxonomies: AnyTaxonomy[] = [];
  let relativeConfigPath: string | undefined;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let isGenerating = false;
  let pendingRegenerate = false;
  let isInitialized = false;
  // Queue of resolvers waiting for current generation to finish
  let generationWaiters: Array<() => void> = [];
  let initializationPromise: Promise<void> | null = null;
  const affectedCollections = new Set<string>();

  async function writeSharedFiles(): Promise<void> {
    if (!engine) return;

    // index.js and index.d.ts must declare the SAME set of collections (the
    // full configured list) so the generated types never outrun the runtime.
    const collectionNames = collections.map((c) => c.name);
    const writePromises: Promise<void>[] = [];

    const indexContent = generateIndex(collectionNames);
    writePromises.push(writeFile(path.join(outDir, "index.js"), indexContent, "utf-8"));

    const dataTypesContent = generateDataTypes(collections);
    writePromises.push(writeFile(path.join(outDir, "index.d.ts"), dataTypesContent, "utf-8"));

    const moduleTypesContent = generateTypes(
      collections,
      taxonomies,
      relativeConfigPath === undefined ? {} : { configPath: relativeConfigPath },
    );
    writePromises.push(writeFile(path.join(outDir, "types.d.ts"), moduleTypesContent, "utf-8"));

    if (writeNodeModulesTypes) {
      const nodeModulesDir = path.join(cwd, "node_modules", ".docks");
      await mkdir(nodeModulesDir, { recursive: true });
      writePromises.push(
        writeFile(path.join(nodeModulesDir, "types.d.ts"), moduleTypesContent, "utf-8"),
      );
    }

    await Promise.all(writePromises);
  }

  async function writeCollectionFile(collectionName: string): Promise<void> {
    if (!engine) return;
    const entries = engine.getCollection(collectionName);
    // Look up the collection config to get output options
    const colConfig = collections.find((c) => c.name === collectionName);
    const content = serializeEntries(entries, colConfig?.output);
    await writeFile(path.join(outDir, `${collectionName}.js`), content, "utf-8");
  }

  async function incrementalRegenerate(): Promise<GenerateResult> {
    if (!engine || !isInitialized) {
      throw new Error("Engine not initialized");
    }

    const start = performance.now();

    log(`Incremental rebuild for ${affectedCollections.size} collection(s)...`);

    const writePromises: Promise<void>[] = [];
    for (const collectionName of affectedCollections) {
      log(`  Regenerating ${collectionName}...`);
      writePromises.push(writeCollectionFile(collectionName));
    }
    writePromises.push(writeSharedFiles());

    await Promise.all(writePromises);

    const duration = performance.now() - start;
    const allCollections = engine.getCollections();
    const entryCount = allCollections.reduce((sum, col) => sum + col.entries.length, 0);

    log(`Incremental rebuild completed in ${duration.toFixed(0)}ms`);

    affectedCollections.clear();

    return {
      outDir,
      collections: allCollections.map((c) => c.name),
      entryCount,
      typesPath: path.join(outDir, "types.d.ts"),
      indexPath: path.join(outDir, "index.js"),
      duration,
    };
  }

  const fullRegenerate = async (): Promise<GenerateResult> => {
    if (isGenerating) {
      pendingRegenerate = true;
      // Wait for current generation to finish, then retry
      await new Promise<void>((resolve) => {
        generationWaiters.push(resolve);
      });
      return fullRegenerate();
    }

    isGenerating = true;
    pendingRegenerate = false;

    try {
      const result = await generate({ ...options, clean: false });
      options.onGenerate?.(result);
      return result;
    } catch (error) {
      options.onError?.(error as Error);
      throw error;
    } finally {
      isGenerating = false;
      // Notify all waiters that generation is complete
      const waiters = generationWaiters;
      generationWaiters = [];
      waiters.forEach((resolve) => resolve());

      if (pendingRegenerate) {
        // Another change came in while we were generating
        fullRegenerate().catch(() => {});
      }
    }
  };

  const generationMutex = new AsyncMutex();

  const debouncedIncrementalRegenerate = () => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(async () => {
      await generationMutex.runExclusive(async () => {
        if (!isInitialized || affectedCollections.size === 0) return;
        try {
          const result = await incrementalRegenerate();
          options.onGenerate?.(result);
        } catch (error) {
          options.onError?.(error as Error);
        }
      });
    }, debounceMs);
  };

  initializationPromise = fullRegenerate()
    .then(async () => {
      // Get collections and taxonomies from options or resolve from config
      if (options.collections && options.collections.length > 0) {
        collections = options.collections;
        taxonomies = options.taxonomies ?? [];
      } else {
        const config = await resolveConfig(cwd);
        collections = config.collections;
        taxonomies = config.taxonomies;
        // Calculate relative path from output directory to config for type imports
        if (config.configPath) {
          const relativePath = path.relative(outDir, config.configPath);
          relativeConfigPath = relativePath
            .split(path.sep)
            .join("/")
            .replace(/\.(ts|js|mjs)$/, "");
          if (!relativeConfigPath.startsWith(".")) {
            relativeConfigPath = "./" + relativeConfigPath;
          }
        }
      }

      log("Initializing incremental watch mode...");
      engine = createEngine({
        collections,
        taxonomies,
        cwd,
        ...(options.cache !== undefined && { cache: options.cache }),
      });
      await engine.scan();

      engineUnwatch = engine.watch((event) => {
        affectedCollections.add(event.collection);
        debouncedIncrementalRegenerate();
      });

      isInitialized = true;
      log("Incremental watch mode enabled");
      return undefined;
    })
    .catch((error) => {
      options.onError?.(error as Error);
    });

  return {
    close: async () => {
      if (timeout) clearTimeout(timeout);
      if (initializationPromise) {
        await initializationPromise;
      }
      if (engineUnwatch) {
        engineUnwatch();
        engineUnwatch = null;
      }
    },
    regenerate: fullRegenerate,
  };
}
