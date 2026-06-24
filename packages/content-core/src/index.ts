export {
  defineCollection,
  defineConfig,
  ValidationError,
  TransformError,
  SerializationError,
  isMDXEntry,
} from "./types";

export { defineTaxonomy, isEnumTaxonomy, isSchemaTaxonomy, getTaxonomySlugs } from "./taxonomy";

export type {
  TaxonomyConfig,
  SchemaTaxonomyConfig,
  EnumTaxonomyConfig,
  AnyTaxonomy,
  TaxonomyTerm,
} from "./taxonomy";

export type {
  AssetsConfig,
  CacheOptions,
  Collection,
  CollectionConfig,
  CollectionEntry,
  CollectionRegistry,
  TaxonomyRegistry,
  CollectionSchema_,
  DefaultEntry,
  Document,
  DocumentMeta,
  Engine,
  EngineConfig,
  Entry,
  EntryMeta,
  InferEntry,
  InferOutput,
  TransformContext,
  TransformFn,
  ValidationIssue,
  ValidationMode,
  WatchCallback,
  WatchEvent,
  AnyCollection,
  RuntimeEntry,
  SerializationIssueInfo,
  CollectionData,
  CollectionTransformed,
  WorkflowConfig,
  VoiceConfig,
  VoiceTrainingConfig,
  GlobalVoiceConfig,
  TerminologyEntry,
  ComputedFields,
  ComputedFieldFn,
  InferComputedFields,
  MDXConfig,
  MDXData,
  PluginConfig,
  OutputConfig,
} from "./types";

export {
  getEntry,
  getCollection,
  getCollections,
  invalidateRuntimeEngine,
  getWorkflowConfig,
  getTaxonomy,
  getTaxonomyTerms,
  getTaxonomies,
  getTermLabel,
  getTermLabels,
  setData,
  setTaxonomies,
  setWorkflowConfigs,
} from "./runtime";
export type { CollectionWorkflowConfig } from "./runtime";

export { query, Query } from "./query";
export type { PaginationOptions, PaginationMeta, PaginatedResult, QueryOptions } from "./query";
export { reference, markAsReference, isReference, getReferenceTarget } from "./reference";
export { generateRss, generateSitemap } from "./feeds";
export type { FeedOptions, FeedEntry } from "./feeds";
export { generateLlmsTxt } from "./llms-txt";
export type { LlmsTxtOptions, LlmsTxtEntry, LlmsTxtSection } from "./llms-txt";

// The `.md` twin path is pure and runtime-safe — a doc page links to its own twin.
// The build-time emitters (renderLlmsIndex/renderLlmsFull/renderMarkdownTwin) live
// in the `@lesto/content-core/build` barrel.
export { markdownTwinPath } from "./llms-docs";
export type { LlmsDocPage, LlmsDocSection, LlmsDocsOptions } from "./llms-docs";

// RAG context primitives for AI chat integration
export { buildRAGContext, formatContextForLLM, estimateTokens } from "./rag";
export type {
  RAGContext,
  RAGEntry,
  RAGOptions,
  RAGPrioritization,
  RAGFormat,
  FormatOptions,
} from "./rag";

// NOTE: Schema.org / JSON-LD generation has moved to @lesto/content-seo
// import { jsonLd, generateSchemaOrg } from "@lesto/content-seo";

export { wordCount, readingTime, excerpt } from "./computed";
export {
  createImport,
  createNamedImport,
  isImportReference,
  IMPORT_MARKER,
  ImportCollector,
} from "./imports";

// Asset utilities (browser-safe)
export { ALLOWED_MIME_TYPES, EXTENSION_TO_MIME, isImageType, isVideoType } from "./assets";

export type {
  ImportReference,
  NamedImportReference,
  AnyImportReference,
  CollectedImport,
} from "./imports";

export { parseFrontmatter, hasFrontmatter, stringify, extractExcerpt } from "@lesto/content-umbra";

export type {
  ParseOutput,
  ParseResult as FrontmatterParseResult,
  FrontmatterLanguage,
} from "@lesto/content-umbra";

export type {
  RenderOptions,
  RenderResult,
  Heading,
  ReadingTime,
  Renderer,
} from "@lesto/content-markdown";

// NOTE: Voice, AI, and build functions require Node.js and are available via:
//   import { generate, sampleEntries, resolveAIConfig } from "@lesto/content-core/build"

// Voice types (types only - no runtime imports)
export type {
  VoiceSample,
  VoiceContext,
  VoiceSystemPromptOptions,
  VoiceCacheMetadata,
  CachedVoiceProfile,
} from "./voice";

// AI types (types only - no runtime imports)
export type { AIConfig, AIProvider, ResolvedAIConfig } from "./types";

// Voice training data generation (browser-safe - no fs imports)
export {
  // Content chunking
  countWords,
  chunkContent,
  chunkVoiceSample,
  chunkVoiceSamples,
  // Instruction generation
  generateInstruction,
  generateInstructionsForChunk,
  generateInstructionsForChunks,
  // Training pair formatting
  formatTrainingPair,
  formatTrainingPairs,
  generateTrainingData,
  // Export formats
  exportAsJSONL,
  exportAsAlpaca,
  exportAsAlpacaJSON,
  // Statistics
  calculateTrainingStats,
} from "./voice-training";

export type {
  ContentChunk,
  ChunkingOptions,
  InstructionType,
  InstructionPair,
  TrainingPair,
  TrainingDataOptions,
  JSONLExportOptions,
  AlpacaEntry,
  TrainingDataStats,
} from "./voice-training";

// NOTE: AI Semantic Search APIs are NOT re-exported here.
// Import directly from the dedicated package:
//   import { search, cosineSimilarity, loadSearchIndex } from "@lesto/content-search"
