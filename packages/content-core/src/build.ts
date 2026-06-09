/**
 * @keel/content-core/build - Build tools for content generation
 *
 * This entry point exports Node.js-only APIs for generating content.
 * Use this for CLI tools, build scripts, and server-side generation.
 *
 * For runtime APIs (browser-safe), use:
 *   import { query } from "@keel/content-core"
 */

// Re-export types only (not runtime functions that depend on @keel/content-content)
export type {
  AnyCollection,
  Collection,
  CollectionConfig,
  CollectionEntry,
  CollectionRegistry,
  DocumentMeta,
  RuntimeEntry,
  DeployConfig,
  DeployProvider,
  VoiceTrainingConfig,
  SearchConfig,
  SearchConfigOptions,
  Engine,
} from "./types";

// =============================================================================
// Build API (Node.js only)
// =============================================================================

// Config
export { resolveConfig } from "./config";
export type { ResolvedConfig } from "./config";

// Pipeline
export { runPipeline, pipeline } from "./pipeline";
export type { PipelineResult, PipelineOptions } from "./pipeline";

// Parser
export type { ParseOptions, ParsedDocument, ParseResult } from "./parser";

// Engine
export { createEngine } from "./engine";

// Static Generation
export { generate, watch } from "./generator";
export type { GenerateOptions, GenerateResult, WatchOptions, WatchHandle } from "./generator";

// Type generation
export { generateTypes } from "./typegen";

// Serialization Validation
export {
  validateSerializable,
  hasCriticalIssues,
  formatSerializationIssues,
} from "./serialization";
export type { SerializationIssue, ValidationResult } from "./serialization";

// Events
export { createEventEmitter, createNoopEmitter } from "./events";

export type {
  EventEmitter,
  BuildEventType,
  EventPayloadMap,
  EventListener,
  WildcardListener,
  BaseEventPayload,
  BuildStartPayload,
  BuildEndPayload,
  BuildErrorPayload,
  CollectEventPayload,
  CollectEndPayload,
  ParseEventPayload,
  ParseEndPayload,
  TransformEventPayload,
  TransformEndPayload,
  WriteEventPayload,
  WriteEndPayload,
  ValidationWarningPayload,
  TransformErrorPayload,
  SerializationWarningPayload,
} from "./events";

// Cache
export { createCacheManager, initHasher, hashString, hashObject } from "./cache";

export type {
  CacheManager,
  CacheManifest,
  CachedParseResult,
  CachedTransformResult,
  CacheStats,
  CollectionCacheMeta,
} from "./cache";

// Workers
export { createWorkerPool } from "./workers";

export type { WorkerPool, WorkerTask, WorkerResult } from "./workers";

// Doctor
export { doctor } from "./doctor";
export type { DoctorConfig, DoctorOptions, DoctorResult, DoctorIssue } from "./doctor";

// Init & New commands
export { runInit } from "./init";
export { createNewEntry } from "./new";

// Import commands
export { importWordPress, parseWxrItems, htmlToMarkdown } from "./import";
export type { WxrImportOptions, ImportResult, ImportError, WxrPost } from "./import";

// Parsers (full set from umbra)
export {
  resolveParser,
  getDefaultIncludePatterns,
  detectParserByExtension,
  isValidPreset,
  getParserExtensions,
  jsonParser,
  yamlParser,
  frontmatterParser,
  frontmatterOnlyParser,
  JsonParseError,
  YamlParseError,
  FrontmatterParseError,
} from "@keel/content-umbra";

export type {
  Parser,
  ParserOption,
  ParserPreset,
} from "@keel/content-umbra";

// Markdown rendering
export { createRenderer } from "@keel/content-markdown";

// Voice profile and training
export {
  sampleEntries,
  sampleEntriesByAuthor,
  writeVoiceSamples,
  readVoiceSamples,
  listVoiceSampleAuthors,
  buildVoiceContext,
  resolveVoiceConfig,
  getVoiceSamplesPath,
  buildVoiceExamplesPrompt,
  buildTerminologyPrompt,
  buildVoicePrompt,
  buildVoiceSystemPrompt,
  buildVoiceSystemPromptFromSamples,
  // Caching
  getVoiceCachePath,
  computeContentHash,
  readCachedVoiceProfile,
  writeCachedVoiceProfile,
  isCacheValid,
  getVoiceSamplesWithCache,
  invalidateVoiceCache,
  invalidateAllVoiceCaches,
  getVoiceCacheStats,
  // Path security utilities
  PathTraversalError,
  sanitizePathSegment,
  validatePathWithinBase,
} from "./voice";

export type {
  VoiceSample,
  VoiceContext,
  VoiceSystemPromptOptions,
  VoiceCacheMetadata,
  CachedVoiceProfile,
} from "./voice";

// AI configuration
export {
  resolveAIConfig,
  isAIConfigured,
  validateAIConfig,
  getAIConfigStatus,
} from "./ai-config";

export type { AIConfig, AIProvider, ResolvedAIConfig } from "./types";

// Voice training data generation
export {
  countWords,
  chunkContent,
  chunkVoiceSample,
  chunkVoiceSamples,
  generateInstruction,
  generateInstructionsForChunk,
  generateInstructionsForChunks,
  formatTrainingPair,
  formatTrainingPairs,
  generateTrainingData,
  exportAsJSONL,
  exportAsAlpaca,
  exportAsAlpacaJSON,
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

// Assets (build-time only - requires Node.js path module)
export {
  resolveAssetsConfig,
  resolveAssetPath,
  getAssetRelativePath,
  isImageType,
  isVideoType,
  ALLOWED_MIME_TYPES,
  EXTENSION_TO_MIME,
} from "./assets";

export type { ResolvedAssetsConfig } from "./assets";

// NOTE: Embedding generation and search APIs are NOT re-exported here.
// Import directly from the dedicated packages:
//   - @keel/content-embeddings: Build-time embedding generation
//   - @keel/content-search: Runtime vector similarity search
