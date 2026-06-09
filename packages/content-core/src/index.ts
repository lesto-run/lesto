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

// NOTE: Schema.org / JSON-LD generation has moved to @keel/content-seo
// import { jsonLd, generateSchemaOrg } from "@keel/content-seo";

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

export { parseFrontmatter, hasFrontmatter, stringify, extractExcerpt } from "@keel/content-umbra";

export type {
  ParseOutput,
  ParseResult as FrontmatterParseResult,
  FrontmatterLanguage,
} from "@keel/content-umbra";

export type {
  RenderOptions,
  RenderResult,
  Heading,
  ReadingTime,
  Renderer,
} from "@keel/content-markdown";

// NOTE: Voice, AI, and build functions require Node.js and are available via:
//   import { generate, sampleEntries, resolveAIConfig } from "@keel/content-core/build"

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
//   import { search, cosineSimilarity, loadSearchIndex } from "@keel/content-search"
