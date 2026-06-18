import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ParserOption } from "@lesto/content-umbra";
import type { RenderOptions, RenderResult } from "@lesto/content-markdown";
import type { AnyTaxonomy } from "./taxonomy";

export interface CacheOptions {
  enabled?: boolean;
  cacheDir?: string;
  clearCache?: boolean;
}

/**
 * Plugin configuration for remark/rehype plugins.
 * Can be a plugin module name, or a tuple with plugin and options.
 */
export type PluginConfig = string | [string, Record<string, unknown>];

/**
 * Configuration for MDX compilation in a collection.
 */
export interface MDXConfig {
  /**
   * Component map for MDX files in this collection.
   * Keys are component names used in MDX, values are import paths.
   * @example { Alert: './src/components/Alert', CodeBlock: './src/components/CodeBlock' }
   */
  components?: Record<string, string>;

  /**
   * Remark plugins for MDX processing.
   */
  remarkPlugins?: PluginConfig[];

  /**
   * Rehype plugins for MDX processing.
   */
  rehypePlugins?: PluginConfig[];

  /**
   * Scope variables available in all MDX files.
   */
  scope?: Record<string, unknown>;
}

/**
 * MDX compilation result stored in the entry.
 * The code includes all bundled components via mdx-bundler.
 */
export interface MDXData {
  /** Bundled MDX code (includes all imported components) */
  code: string;
}

/**
 * Configuration for asset handling (images, videos, etc.)
 */
export interface AssetsConfig {
  /**
   * Assets directory (relative to cwd).
   * If set, all collections share this directory.
   * If not set, defaults to {collection}/_assets (e.g., content/posts/_assets).
   * @example "public/images"
   */
  directory?: string;

  /**
   * Allowed file extensions for uploads.
   * @default ["jpg", "jpeg", "png", "gif", "webp", "svg", "mp4", "webm"]
   */
  allowedExtensions?: string[];

  /**
   * Maximum file size in bytes.
   * @default 52428800 (50MB)
   */
  maxFileSize?: number;
}

/**
 * Workflow configuration for content states (draft, scheduled, published).
 * Enables automatic filtering of unpublished content in production.
 */
export interface WorkflowConfig {
  /** Field name in schema that holds the status value (e.g., "status") */
  statusField: string;
  /** Field name for the publication date (e.g., "publishedAt") */
  publishDateField?: string;
  /** Field name for content expiration date (e.g., "expiresAt") */
  expirationField?: string;
  /**
   * Whether to auto-filter unpublished content out of getCollection/getEntry.
   * Defaults to true (the safe default — drafts are hidden unless you opt out
   * with `filterUnpublished: false`).
   */
  filterUnpublished?: boolean;
}

/**
 * Configuration for voice training data generation.
 * Controls how content is chunked and formatted for fine-tuning.
 */
export interface VoiceTrainingConfig {
  /**
   * Minimum words per training chunk.
   * @default 250
   */
  minWords?: number;
  /**
   * Maximum words per training chunk.
   * @default 650
   */
  maxWords?: number;
  /**
   * Target words per chunk - algorithm tries to get close to this.
   * @default 400
   */
  targetWords?: number;
  /**
   * Instruction types to generate for training pairs.
   * Available types: write, explain, elaborate, summarize, continue, rewrite
   * @default ["write"]
   */
  instructionTypes?: ("write" | "explain" | "elaborate" | "summarize" | "continue" | "rewrite")[];
  /**
   * Whether to give exemplary content more weight in training data.
   * @default true
   */
  prioritizeExemplary?: boolean;
  /**
   * How many times to duplicate exemplary content in training data.
   * Only applies when prioritizeExemplary is true.
   * @default 2
   */
  exemplaryMultiplier?: number;
  /**
   * Default output format for training data.
   * - jsonl: JSON Lines format with instruction/output pairs
   * - alpaca: Alpaca format with instruction/input/output structure
   * @default "jsonl"
   */
  outputFormat?: "jsonl" | "alpaca";
}

/**
 * Output configuration for controlling what's included in generated files.
 * Controls bundle size by excluding unnecessary data from production builds.
 */
export interface OutputConfig {
  /**
   * Include raw markdown content in output.
   * Set to false to reduce bundle size when you only need rendered HTML.
   * Note: Some features like RAG search and editing require raw content.
   * @default true
   */
  includeContent?: boolean;
}

/**
 * Voice profile configuration for AI-assisted writing.
 * Enables building voice profiles from existing content to capture each author's unique style.
 */
export interface VoiceConfig {
  /**
   * Whether to build separate voice profiles per author.
   * Requires an "author" field in the schema.
   * @default false
   */
  perAuthor?: boolean;
  /**
   * Maximum number of entries to sample for voice profile building.
   * @default 10
   */
  limit?: number;
  /**
   * Minimum number of entries required to build a voice profile.
   * Collections with fewer entries won't have a profile generated.
   * @default 3
   */
  minEntries?: number;
  /**
   * Field name that identifies the author (e.g., "author", "authorId").
   * Required when perAuthor is true.
   * @default "author"
   */
  authorField?: string;
  /**
   * Field name in frontmatter that marks an entry as a voice model example.
   * Entries with this field set to true will be prioritized when sampling content
   * for voice profile building.
   * @default "voiceModel"
   * @example
   * ```markdown
   * ---
   * title: My Best Post
   * voiceModel: true
   * ---
   * ```
   */
  exemplaryField?: string;
  /**
   * Training data generation configuration.
   * Controls how content is chunked and formatted for fine-tuning LLMs.
   */
  training?: VoiceTrainingConfig;
}

export type InferOutput<T> = T extends StandardSchemaV1<unknown, infer O> ? O : never;

export type CollectionSchema = StandardSchemaV1<Record<string, unknown>, Record<string, unknown>>;

/**
 * Computed field function that derives a value from an entry.
 * Receives the parsed entry data including content and slug.
 */
export type ComputedFieldFn<TSchema extends CollectionSchema, TOutput = unknown> = (
  entry: InferOutput<TSchema> & { content: string; slug: string },
) => TOutput;

/**
 * Map of computed field names to their computation functions.
 * Each function receives the entry and returns a derived value.
 */
export type ComputedFields<TSchema extends CollectionSchema> = Record<
  string,
  ComputedFieldFn<TSchema, unknown>
>;

/**
 * Infer the type of computed fields from a ComputedFields object.
 * Extracts return types of all computed field functions.
 */
export type InferComputedFields<T> =
  T extends Record<string, (entry: never) => unknown>
    ? { [K in keyof T]: T[K] extends (entry: never) => infer TOutput ? TOutput : never }
    : Record<string, never>;

export interface DocumentMeta {
  path: string;
  fileName: string;
  extension: string;
  directory: string;
  /**
   * Path segments from collection root to this entry.
   * Enables easy hierarchy/section derivation.
   * @example ['getting-started', 'introduction'] for 'getting-started/introduction.md'
   * @example ['getting-started'] for 'getting-started/index.md'
   */
  pathSegments: string[];
  /**
   * True if this entry is a directory index (filename is 'index' or 'README').
   * Index pages represent their parent directory in navigation.
   */
  isIndex: boolean;
}

export interface Document<TData extends Record<string, unknown> = Record<string, unknown>> {
  readonly data: TData;
  readonly content: string;
  readonly file: DocumentMeta;
}

export interface EntryMeta {
  readonly id: string;
  readonly collection: string;
  readonly file: DocumentMeta;
}

export type DefaultEntry<TData extends Record<string, unknown> = Record<string, unknown>> = TData &
  EntryMeta & {
    readonly content: string;
    readonly slug: string;
    readonly rendered?: RenderResult;
    /** MDX compilation data (only present for .mdx files) */
    readonly mdx?: MDXData;
  };

export type Entry<T extends Record<string, unknown> = Record<string, unknown>> = T & EntryMeta;

export interface TransformContext {
  documents<T extends AnyCollection>(collection: T): InferEntry<T>[];
  cache<T>(key: string, fn: () => T | Promise<T>): Promise<T>;
  skip(): never;
  readonly collection: { name: string; directory: string };
  readonly filePath: string;
}

export type TransformFn<
  TData extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = Record<string, unknown>,
> = (document: Document<TData>, context: TransformContext) => TOutput | Promise<TOutput>;

export interface CollectionConfig<
  TSchema extends CollectionSchema = CollectionSchema,
  TTransformedSchema extends CollectionSchema | undefined = undefined,
  TComputed extends ComputedFields<TSchema> = ComputedFields<TSchema>,
> {
  name: string;
  directory: string;
  include?: string | string[];
  exclude?: string | string[];
  schema: TSchema;
  transform?: TransformFn<InferOutput<TSchema>, Record<string, unknown>>;
  /** Schema for transform output - enables type generation for transformed data */
  transformedSchema?: TTransformedSchema;
  /** Validate that transform output is serializable. Defaults to true */
  validateSerialization?: boolean;
  /**
   * Parser to use for this collection.
   * Built-in presets: "frontmatter" (default), "frontmatter-only", "json", "yaml"
   * Can also be a custom parser object or parse function.
   */
  parser?: ParserOption;
  /**
   * Markdown rendering options.
   * - `false`: Disable rendering, expose raw markdown body
   * - `RenderOptions`: Pass options to the renderer
   * - `undefined` (default): Auto-render markdown unless transform is provided
   */
  render?: RenderOptions | false;
  /**
   * Workflow configuration for content states (draft, scheduled, published).
   * Enables automatic filtering of unpublished content.
   */
  workflow?: WorkflowConfig;
  /**
   * Override assets configuration for this collection.
   * Set to string for simple directory path, or object for full config.
   */
  assets?: string | AssetsConfig;
  /**
   * Custom content template for new entries created with `docks new`.
   * Supports variable substitution:
   * - {{title}} - The title passed to the command
   * - {{slug}} - The slugified title
   * - {{date}} - Current ISO date string
   * - {{git.user}} - Git user.name (if available)
   * - {{git.email}} - Git user.email (if available)
   * @example
   * ```
   * template: `---
   * title: "{{title}}"
   * draft: true
   * author: "{{git.user}}"
   * date: "{{date}}"
   * ---
   *
   * ## TL;DR
   *
   * [One sentence summary]
   * `
   * ```
   */
  template?: string;
  /**
   * Computed fields that derive values from entry data.
   * Each field is a function that receives the parsed entry and returns a computed value.
   * Computed fields are added to the entry after parsing and transformation.
   * @example
   * ```typescript
   * computed: {
   *   publishYear: (entry) => entry.publishedAt.getFullYear(),
   *   isRecent: (entry) => {
   *     const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
   *     return entry.publishedAt.getTime() > thirtyDaysAgo
   *   },
   * }
   * ```
   */
  computed?: TComputed;
  /**
   * MDX-specific configuration. Only applies to .mdx files.
   * To enable MDX support, set include to include .mdx files (e.g., '**\/*.{md,mdx}').
   */
  mdx?: MDXConfig;
  /**
   * Voice profile configuration for AI-assisted writing.
   * Enables building voice profiles from existing content to capture each author's unique style.
   */
  voice?: VoiceConfig;
  /**
   * Output configuration for controlling what's included in generated files.
   * Use to reduce bundle size by excluding unnecessary data.
   * @example
   * ```typescript
   * output: { includeContent: false } // Exclude raw markdown, keep rendered HTML
   * ```
   */
  output?: OutputConfig;
}

export type AnyCollection = CollectionConfig<
  CollectionSchema,
  CollectionSchema | undefined,
  ComputedFields<CollectionSchema>
>;

export type InferEntry<T extends AnyCollection> = T["transformedSchema"] extends CollectionSchema
  ? Entry<InferOutput<T["transformedSchema"]>> &
      (T["computed"] extends Record<string, (entry: never) => unknown>
        ? InferComputedFields<T["computed"]>
        : Record<string, never>)
  : T["transform"] extends TransformFn<never, infer O>
    ? Entry<O> &
        (T["computed"] extends Record<string, (entry: never) => unknown>
          ? InferComputedFields<T["computed"]>
          : Record<string, never>)
    : DefaultEntry<InferOutput<T["schema"]>> &
        (T["computed"] extends Record<string, (entry: never) => unknown>
          ? InferComputedFields<T["computed"]>
          : Record<string, never>);

/** Entry type used at runtime when schema/transform types are not known statically */
export type RuntimeEntry = Record<string, unknown> & EntryMeta;

/**
 * Type guard to check if an entry is an MDX entry.
 * MDX entries have an mdx field with bundled code.
 */
export function isMDXEntry(entry: RuntimeEntry): entry is RuntimeEntry & { mdx: MDXData } {
  return entry["mdx"] !== undefined;
}

export type ValidationMode = "development" | "production";

/**
 * Terminology entry mapping incorrect terms to preferred terms.
 */
export interface TerminologyEntry {
  /** The incorrect or discouraged term */
  incorrect: string;
  /** The preferred/correct term to use instead */
  preferred: string;
  /** Optional explanation of why this term is preferred */
  reason?: string;
}

/**
 * Organization-wide voice configuration for AI-assisted writing.
 * Applies across all collections.
 */
export interface GlobalVoiceConfig {
  /**
   * Terminology map for consistent term usage across the organization.
   * Feeds into AI prompts for correct term usage and can be used for lint rules.
   * @example
   * ```typescript
   * terminology: [
   *   { incorrect: "click here", preferred: "select", reason: "More accessible" },
   *   { incorrect: "utilize", preferred: "use", reason: "Simpler language" },
   * ]
   * ```
   */
  terminology?: TerminologyEntry[];
}

/**
 * AI provider type for configuration.
 */
export type AIProvider = "anthropic" | "openai";

/**
 * Configuration for AI-powered features.
 * API keys can be provided directly or via environment variables.
 *
 * Environment variable fallbacks:
 * - Anthropic: ANTHROPIC_API_KEY
 * - OpenAI: OPENAI_API_KEY
 */
export interface AIConfig {
  /**
   * AI provider to use.
   * @default "anthropic"
   */
  provider?: AIProvider;

  /**
   * API key for the AI provider.
   * If not provided, falls back to environment variable:
   * - Anthropic: ANTHROPIC_API_KEY
   * - OpenAI: OPENAI_API_KEY
   */
  apiKey?: string;

  /**
   * Model to use for AI operations.
   * Defaults based on provider:
   * - Anthropic: "claude-sonnet-4-20250514"
   * - OpenAI: "gpt-4o"
   */
  model?: string;

  /**
   * Maximum tokens for AI responses.
   * @default 4096
   */
  maxTokens?: number;

  /**
   * Temperature for AI responses (0-1).
   * Lower values are more deterministic.
   * @default 0.7
   */
  temperature?: number;

  /**
   * Enable AI features.
   * Set to false to disable all AI functionality.
   * @default true
   */
  enabled?: boolean;
}

/**
 * Resolved AI configuration with all defaults applied.
 */
export interface ResolvedAIConfig {
  provider: AIProvider;
  apiKey: string | null;
  model: string;
  maxTokens: number;
  temperature: number;
  enabled: boolean;
}

/**
 * Supported deployment providers.
 */
export type DeployProvider = "vercel" | "netlify" | "cloudflare";

/**
 * Deploy configuration for one-command deploys.
 */
export interface DeployConfig {
  /** Hosting provider (default: "vercel") */
  provider?: DeployProvider;
  /** Project ID or link from the provider */
  projectId?: string;
  /** Output directory to deploy (default: inferred from generate) */
  outputDir?: string;
  /** Environment variables to set during deployment */
  environment?: Record<string, string>;
}

/**
 * Search configuration for zero-config semantic search.
 *
 * Set to `true` for all defaults, or provide an object for customization.
 */
export type SearchConfig = boolean | SearchConfigOptions;

/**
 * Detailed search configuration options.
 */
export interface SearchConfigOptions {
  /** Enable search (default: true when config is provided) */
  enabled?: boolean;
  /** Output directory for search index (default: 'public') */
  outputDir?: string;
  /** Output filename (default: 'search-index.json') */
  outputFile?: string;

  // Quality options
  /** Enable typo tolerance (default: true, max 2 edits) */
  typoTolerance?: boolean | { maxEdits: number };
  /** Enable stemming (default: true) */
  stemming?: boolean;
  /** Custom synonyms map */
  synonyms?: Record<string, string[]>;

  // Collection filtering
  /** Collections to include (default: all) */
  include?: string[];
  /** Collections to exclude */
  exclude?: string[];

  // Advanced options
  /** Use binary quantization for 32x smaller index (default: true) */
  quantization?: "none" | "binary";
  /** Fields to index for search (default: ['title', 'content', 'excerpt']) */
  fields?: string[];
}

export interface EngineConfig<
  TCollections extends AnyCollection[] = AnyCollection[],
  TTaxonomies extends AnyTaxonomy[] = AnyTaxonomy[],
> {
  cwd?: string;
  collections: TCollections;
  taxonomies?: TTaxonomies;
  mode?: ValidationMode;
  cache?: CacheOptions;
  /** Global assets configuration. Can be overridden per-collection. */
  assets?: AssetsConfig;
  /**
   * Global voice configuration for AI-assisted writing.
   * Includes organization-wide terminology and style guidelines.
   */
  voice?: GlobalVoiceConfig;
  /**
   * AI configuration for AI-powered features.
   * If not configured, AI features will attempt to use environment variables.
   */
  ai?: AIConfig;
  /**
   * Deploy configuration for one-command deploys.
   */
  deploy?: DeployConfig;
  /**
   * Search configuration for zero-config semantic search.
   * Set to `true` for all defaults, or provide an object for customization.
   *
   * @example
   * ```typescript
   * // Enable with defaults
   * search: true
   *
   * // Customize
   * search: {
   *   typoTolerance: { maxEdits: 1 },
   *   include: ['posts', 'docs'],
   * }
   * ```
   */
  search?: SearchConfig;
  onValidationWarning?: (error: ValidationError) => void;
  onTransformError?: (error: TransformError) => void;
  onSerializationWarning?: (error: SerializationError) => void;
}

export interface CollectionRegistry {}

export interface TaxonomyRegistry {}

// ============================================================================
// Config-based Type Inference Utilities
// These utilities extract types from a config at compile time, working with
// ANY Standard Schema library (Zod, Valibot, ArkType, etc.)
// ============================================================================

/**
 * Map of collection names to their configs from an EngineConfig.
 * @example
 * ```typescript
 * type ConfigCollections = CollectionsByName<typeof config>;
 * // { posts: PostsCollection; pages: PagesCollection }
 * ```
 */
export type CollectionsByName<TConfig extends EngineConfig> = {
  [TCollection in TConfig["collections"][number] as TCollection["name"]]: TCollection extends AnyCollection
    ? TCollection
    : never;
};

/**
 * Get a specific collection from config by name.
 * @example
 * ```typescript
 * type PostsCollection = GetCollectionByName<typeof config, "posts">;
 * ```
 */
export type GetCollectionByName<
  TConfig extends EngineConfig,
  TName extends keyof CollectionsByName<TConfig>,
> = CollectionsByName<TConfig>[TName];

/**
 * Get the entry type for a collection from config by name.
 * Works with any Standard Schema library (Zod, Valibot, ArkType, etc.)
 * @example
 * ```typescript
 * type Post = GetEntryByName<typeof config, "posts">;
 * // Full entry type with all fields inferred from schema
 * ```
 */
export type GetEntryByName<
  TConfig extends EngineConfig,
  TName extends keyof CollectionsByName<TConfig>,
  TCollection extends AnyCollection = GetCollectionByName<TConfig, TName> & AnyCollection,
> = InferEntry<TCollection>;

/**
 * Get the schema output type for a collection from config by name.
 * Works with any Standard Schema library (Zod, Valibot, ArkType, etc.)
 * @example
 * ```typescript
 * type PostSchema = GetSchemaByName<typeof config, "posts">;
 * // { title: string; publishedAt: Date; ... }
 * ```
 */
export type GetSchemaByName<
  TConfig extends EngineConfig,
  TName extends keyof CollectionsByName<TConfig>,
  TCollection extends AnyCollection = GetCollectionByName<TConfig, TName> & AnyCollection,
> = InferOutput<TCollection["schema"]>;

export type CollectionEntry<K extends keyof CollectionRegistry> = CollectionRegistry[K] extends {
  entry: infer E;
}
  ? E
  : RuntimeEntry;

export type CollectionSchema_<K extends keyof CollectionRegistry> = CollectionRegistry[K] extends {
  schema: infer S;
}
  ? S
  : Record<string, unknown>;

/**
 * @deprecated Use CollectionEntry instead. This type exists for migration compatibility.
 */
export type CollectionData<K extends keyof CollectionRegistry> = CollectionRegistry[K] extends {
  entry: infer E;
}
  ? E
  : Record<string, unknown>;

/**
 * @deprecated Transformed data is now merged into the entry. Use CollectionEntry instead.
 */
export type CollectionTransformed<K extends keyof CollectionRegistry> =
  CollectionRegistry[K] extends { entry: infer E } ? E : undefined;

export interface ValidationIssue {
  message: string;
  path?: ReadonlyArray<PropertyKey>;
}

function formatValidationIssue(issue: ValidationIssue): string {
  const issuePath = issue.path?.map(String).join(".") || "root";
  return `  - ${issuePath}: ${issue.message}`;
}

export class ValidationError extends Error {
  readonly issues: ValidationIssue[];
  readonly filePath: string;
  readonly collection: string;

  constructor(issues: ValidationIssue[], filePath: string, collection: string) {
    super(
      `Validation failed in "${collection}" at ${filePath}:\n${issues.map(formatValidationIssue).join("\n")}`,
    );
    this.name = "ValidationError";
    this.issues = issues;
    this.filePath = filePath;
    this.collection = collection;
  }
}

export class TransformError extends Error {
  readonly entryId: string;
  readonly filePath: string;
  override readonly cause: unknown;

  constructor(entryId: string, filePath: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Transform failed for "${entryId}": ${message}`);
    this.name = "TransformError";
    this.entryId = entryId;
    this.filePath = filePath;
    this.cause = cause;
  }
}

export interface SerializationIssueInfo {
  path: string;
  type: "function" | "symbol" | "bigint" | "circular" | "undefined";
  message: string;
}

export class SerializationError extends Error {
  readonly issues: SerializationIssueInfo[];
  readonly entryId: string;
  readonly filePath: string;

  constructor(issues: SerializationIssueInfo[], entryId: string, filePath: string) {
    const issueList = issues.map((i) => `  - ${i.message}`).join("\n");
    super(`Serialization failed for "${entryId}" at ${filePath}:\n${issueList}`);
    this.name = "SerializationError";
    this.issues = issues;
    this.entryId = entryId;
    this.filePath = filePath;
  }
}

export function defineCollection<
  TSchema extends CollectionSchema,
  TTransformedSchema extends CollectionSchema | undefined = undefined,
  TComputed extends ComputedFields<TSchema> = ComputedFields<TSchema>,
>(
  config: CollectionConfig<TSchema, TTransformedSchema, TComputed>,
): CollectionConfig<TSchema, TTransformedSchema, TComputed> {
  return config;
}

export function defineConfig<
  TCollections extends AnyCollection[],
  TTaxonomies extends AnyTaxonomy[] = AnyTaxonomy[],
>(config: EngineConfig<TCollections, TTaxonomies>): EngineConfig<TCollections, TTaxonomies> {
  return config;
}

export interface Collection {
  name: string;
  entries: RuntimeEntry[];
}

export interface WatchEvent {
  type: "add" | "change" | "unlink";
  path: string;
  collection: string;
  entry?: RuntimeEntry;
}

export type WatchCallback = (event: WatchEvent) => void;

export interface Engine {
  scan(): Promise<void>;
  watch(callback: WatchCallback): () => void;
  getCollections(): Collection[];
  getCollection(name: string): RuntimeEntry[];
  getEntry(collection: string, slug: string): RuntimeEntry | undefined;
  generateTypes(): string;
  writeTypes(outDir?: string): Promise<string>;
}
