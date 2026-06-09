import yaml from "js-yaml";
import { createImmutableCache, CACHE_LIMITS, deepClone } from "@keel/content-shared/cache";
import { ParseError } from "@keel/content-shared/errors";
import { sanitizeObject } from "@keel/content-shared/sanitize";
import type { Parser, ParseOutput } from "./types";

// ============================================================================
// Character Code Constants (for readability and V8 optimization)
// ============================================================================

const CHAR_DASH = 45;       // '-'
const CHAR_DOT = 46;        // '.'
const CHAR_LF = 10;         // '\n'
const CHAR_CR = 13;         // '\r'
const CHAR_SPACE = 32;      // ' '
const CHAR_TAB = 9;         // '\t'
const CHAR_BOM = 0xfeff;    // BOM

// ============================================================================
// Pre-allocated Objects (avoid allocation in hot paths)
// ============================================================================

const EMPTY_DATA: Record<string, unknown> = Object.freeze(Object.create(null));

// ============================================================================
// YAML Cache (using shared immutable cache to prevent mutation issues)
// ============================================================================

const yamlCache = createImmutableCache<Record<string, unknown>>(
  { max: CACHE_LIMITS.YAML_PARSE },
  deepClone
);

/**
 * Clear the YAML parsing cache.
 * Useful for testing or memory management in long-running processes.
 */
export function clearYamlCache(): void {
  yamlCache.clear();
}

// ============================================================================
// Language Engines (Phase 6: Pre-bound options)
// ============================================================================

export type FrontmatterLanguage = "yaml" | "json";

// Pre-bound yaml options to avoid object creation on every call
const yamlLoadOptions = { schema: yaml.DEFAULT_SCHEMA };
const parseYaml = (str: string): unknown => yaml.load(str, yamlLoadOptions);

interface LanguageEngine {
  parse: (str: string) => unknown;
  stringify?: (obj: unknown) => string;
}

const engines: Record<FrontmatterLanguage, LanguageEngine> = {
  yaml: {
    parse: parseYaml,
    stringify: (obj: unknown) => yaml.dump(obj),
  },
  json: {
    parse: JSON.parse,
    stringify: (obj: unknown) => JSON.stringify(obj, null, 2),
  },
};

// ============================================================================
// Errors
// ============================================================================

/**
 * @deprecated Use ParseError from @keel/content-shared/errors instead.
 * Kept for backwards compatibility.
 */
export class FrontmatterParseError extends ParseError {
  readonly filePath: string;

  constructor(filePath: string, cause: unknown, line?: number, column?: number) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const location = line !== undefined ? ` at line ${line}` : "";
    const context: Record<string, unknown> = { filePath, cause };
    if (line !== undefined) context["line"] = line;
    if (column !== undefined) context["column"] = column;
    super(`Failed to parse frontmatter in ${filePath}${location}: ${message}`, context);
    this.name = "FrontmatterParseError";
    this.filePath = filePath;
  }
}

// ============================================================================
// Types
// ============================================================================

export interface ParseOptions {
  /** Opening and closing delimiters (default: ["---", "---"]) */
  delimiters?: string | [string, string];
  /** Language for parsing (default: "yaml", can also be detected from delimiter) */
  language?: FrontmatterLanguage;
}

export interface ParseResult {
  /** Parsed frontmatter data */
  data: Record<string, unknown>;
  /** Content after frontmatter */
  body: string;
  /** Raw frontmatter string (without delimiters) */
  matter: string;
  /** Whether frontmatter was found */
  hasFrontmatter: boolean;
  /** Detected or specified language */
  language: FrontmatterLanguage;
}

// ============================================================================
// Input Normalization
// ============================================================================

/**
 * Convert input to string. Handles Buffer (Node.js) and strips BOM.
 */
function normalizeInput(input: string | Buffer): string {
  let str: string;
  if (typeof input === "string") {
    str = input;
  } else if (Buffer.isBuffer(input)) {
    str = input.toString("utf8");
  } else {
    str = String(input);
  }
  // Strip BOM if present
  if (str.charCodeAt(0) === CHAR_BOM) {
    return str.slice(1);
  }
  return str;
}

/**
 * Normalize delimiters option to [open, close] tuple.
 * Validates that delimiters are non-empty and safe.
 */
function normalizeDelimiters(
  delimiters?: string | [string, string]
): [string, string] {
  if (!delimiters) {
    return ["---", "---"];
  }
  if (typeof delimiters === "string") {
    if (delimiters.length === 0) {
      throw new Error("Delimiter cannot be an empty string");
    }
    if (delimiters === "\n" || delimiters === "\r" || delimiters === "\r\n") {
      throw new Error("Delimiter cannot be a line ending character");
    }
    return [delimiters, delimiters];
  }
  // Tuple format
  const [open, close] = delimiters;
  if (open.length === 0 || close.length === 0) {
    throw new Error("Delimiter cannot be an empty string");
  }
  if (open === "\n" || open === "\r" || open === "\r\n" ||
      close === "\n" || close === "\r" || close === "\r\n") {
    throw new Error("Delimiter cannot be a line ending character");
  }
  return delimiters;
}

// ============================================================================
// Factory Functions (Phase 3: Reduce object allocation overhead)
// ============================================================================

/**
 * Factory for no-frontmatter result (most common early exit).
 * Inline factory that V8 can optimize.
 */
function createNoFrontmatterResult(content: string): ParseResult {
  return {
    data: EMPTY_DATA,
    body: content,
    matter: "",
    hasFrontmatter: false,
    language: "yaml",
  };
}

/**
 * Factory for successful frontmatter parse result.
 */
function createFrontmatterResult(
  data: Record<string, unknown>,
  body: string,
  matter: string,
  language: FrontmatterLanguage
): ParseResult {
  return {
    data,
    body,
    matter,
    hasFrontmatter: true,
    language,
  };
}

// ============================================================================
// YAML Parsing with Cache (Phase 2 + Phase 6)
// ============================================================================

/**
 * Parse YAML with caching. Isolated try-catch for V8 optimization.
 * Uses immutable cache from @keel/content-shared to prevent mutation issues.
 */
function parseYamlCached(
  matter: string,
  filePath: string
): Record<string, unknown> {
  // Check cache first (returns a clone to prevent mutation)
  const cached = yamlCache.get(matter);
  if (cached !== undefined) {
    return cached;
  }

  // Parse YAML
  let data: unknown;
  try {
    data = parseYaml(matter);
  } catch (error) {
    let line: number | undefined;
    if (error instanceof yaml.YAMLException && error.mark) {
      line = error.mark.line + 2; // +1 for delimiter, +1 for 1-based
    }
    throw new FrontmatterParseError(filePath, error, line);
  }

  // Validate result
  if (data === null || data === undefined) {
    return EMPTY_DATA;
  }

  if (typeof data !== "object" || Array.isArray(data)) {
    throw new FrontmatterParseError(
      filePath,
      new Error("Frontmatter must be a YAML object/map, not a scalar or array")
    );
  }

  // Sanitize to prevent prototype pollution
  const result = sanitizeObject(data as Record<string, unknown>);

  // Add to cache (LRU handles size management, immutable cache handles cloning)
  yamlCache.set(matter, result);

  return result;
}

/**
 * Parse JSON frontmatter. Isolated try-catch for V8 optimization.
 */
function parseJsonFrontmatter(
  matter: string,
  filePath: string
): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(matter);
  } catch (error) {
    throw new FrontmatterParseError(filePath, error);
  }

  if (data === null || data === undefined) {
    return EMPTY_DATA;
  }

  if (typeof data !== "object" || Array.isArray(data)) {
    throw new FrontmatterParseError(
      filePath,
      new Error("Frontmatter must be a JSON object, not a scalar or array")
    );
  }

  // Sanitize to prevent prototype pollution
  return sanitizeObject(data as Record<string, unknown>);
}

// ============================================================================
// Custom Delimiter Parser
// ============================================================================

/**
 * Detect language from text after delimiter.
 * Returns the language and whether it's valid.
 */
function detectLanguageFromDelimiter(
  afterDelim: string,
  defaultLang: FrontmatterLanguage
): { language: FrontmatterLanguage; valid: boolean } {
  if (!afterDelim) return { language: defaultLang, valid: true };
  const lower = afterDelim.toLowerCase();
  if (lower === "json") return { language: "json", valid: true };
  if (lower === "yaml" || lower === "") return { language: defaultLang, valid: true };
  return { language: defaultLang, valid: false };
}

/**
 * Find closing delimiter index in content.
 * Returns -1 if not found.
 */
function findCloseDelimiterIndex(
  str: string,
  searchStart: number,
  closeDelim: string
): number {
  const closePattern = "\n" + closeDelim;
  const closeLen = closeDelim.length;

  // Look for closing delimiter followed by newline
  let closeIdx = str.indexOf(closePattern + "\n", searchStart - 1);
  if (closeIdx !== -1) return closeIdx;

  // Check for end-of-string
  if (str.endsWith("\n" + closeDelim)) {
    return str.length - closeLen - 1;
  }

  return -1;
}

/**
 * Parse frontmatter with custom delimiters (e.g., "+++" for TOML).
 * This is the generic parser that handles any delimiter.
 */
function parseWithDelimiters(
  content: string,
  filePath: string,
  options: ParseOptions
): ParseResult {
  const [openDelim, closeDelim] = normalizeDelimiters(options.delimiters);
  const language = options.language || "yaml";
  const openLen = openDelim.length;
  const closeLen = closeDelim.length;

  // Check if content starts with opening delimiter
  if (!content.startsWith(openDelim)) {
    return createNoFrontmatterResult(content);
  }

  // Find end of opening delimiter line
  const firstNewline = content.indexOf("\n", openLen);
  if (firstNewline === -1) {
    return createNoFrontmatterResult(content);
  }

  // Check character after opening delimiter
  const afterDelim = content.slice(openLen, firstNewline).trim();
  const langResult = detectLanguageFromDelimiter(afterDelim, language);
  if (!langResult.valid) {
    return createNoFrontmatterResult(content);
  }
  const detectedLanguage = langResult.language;

  // Normalize CRLF if present
  const str = content.indexOf("\r") !== -1 ? content.replace(/\r\n?/g, "\n") : content;

  // Re-find first newline after normalization
  const normalizedFirstNewline = str.indexOf("\n", openLen);
  if (normalizedFirstNewline === -1) {
    return createNoFrontmatterResult(content);
  }

  // Find closing delimiter
  const searchStart = normalizedFirstNewline + 1;
  const closeIdx = findCloseDelimiterIndex(str, searchStart, closeDelim);

  if (closeIdx === -1) {
    return {
      data: EMPTY_DATA,
      body: str.slice(searchStart),
      matter: "",
      hasFrontmatter: false,
      language: detectedLanguage,
    };
  }

  // Extract matter and body
  const matterEnd = closeIdx + 1;
  const matter = str.slice(searchStart, matterEnd);
  const bodyStart = Math.min(closeIdx + 1 + closeLen + 1, str.length);
  let body = str.slice(bodyStart);

  // Trim leading newline from body
  if (body.charCodeAt(0) === CHAR_LF) {
    body = body.slice(1);
  }

  // Handle empty frontmatter
  if (matter.length === 0 || isBlank(matter)) {
    return createFrontmatterResult(EMPTY_DATA, body, "", detectedLanguage);
  }

  // Parse with appropriate engine
  const data =
    detectedLanguage === "json"
      ? parseJsonFrontmatter(matter, filePath)
      : parseYamlCached(matter, filePath);

  return createFrontmatterResult(data, body, matter, detectedLanguage);
}

// ============================================================================
// Core Parser (V8-Optimized - Phases 1, 3, 4)
// ============================================================================

/**
 * Handle empty frontmatter case (---\n---\n).
 * Returns result or null if not empty frontmatter.
 */
function tryParseEmptyFrontmatter(content: string, filePath: string): ParseResult | null {
  // Check for immediate closing delimiter (empty frontmatter: "---\n---\n")
  if (content.charCodeAt(4) !== CHAR_DASH || !content.startsWith("---", 4)) {
    return null;
  }

  const c7 = content.charCodeAt(7);
  if (c7 === CHAR_LF) {
    // '\n' - Empty frontmatter "---\n---\n..."
    let bodyStart = 8;
    if (content.charCodeAt(bodyStart) === CHAR_LF) {
      bodyStart++;
    }
    return createFrontmatterResult(EMPTY_DATA, content.slice(bodyStart), "", "yaml");
  }

  // Trailing whitespace or end of string - needs slow path
  if (c7 === CHAR_SPACE || c7 === CHAR_TAB || c7 === undefined || Number.isNaN(c7)) {
    return parseNonStandard(content, filePath);
  }

  return null;
}

/**
 * Parse matter and body from delimiter index.
 * Returns the frontmatter result.
 */
function parseFromDelimiterIndex(
  content: string,
  closeIdx: number,
  filePath: string
): ParseResult {
  const matter = content.slice(4, closeIdx);
  let bodyStart = closeIdx + 5;

  if (content.charCodeAt(bodyStart) === CHAR_LF) {
    bodyStart++;
  }
  const body = content.slice(bodyStart);

  if (matter.length === 0) {
    return createFrontmatterResult(EMPTY_DATA, body, "", "yaml");
  }

  const data = parseYamlCached(matter, filePath);
  return createFrontmatterResult(data, body, matter, "yaml");
}

/**
 * Try to parse using standard delimiter pattern.
 * Returns result or null if pattern not found.
 */
function tryStandardDelimiter(content: string, filePath: string): ParseResult | null {
  // Find closing delimiter "\n---\n"
  const closeIdx = content.indexOf("\n---\n", 4);
  if (closeIdx !== -1) {
    return parseFromDelimiterIndex(content, closeIdx, filePath);
  }

  // Try YAML document end marker "\n...\n"
  const yamlEndIdx = content.indexOf("\n...\n", 4);
  if (yamlEndIdx !== -1) {
    return parseFromDelimiterIndex(content, yamlEndIdx, filePath);
  }

  // Try end-of-string delimiter "\n---"
  if (content.endsWith("\n---")) {
    const matter = content.slice(4, content.length - 4);
    if (matter.length === 0) {
      return createFrontmatterResult(EMPTY_DATA, "", "", "yaml");
    }
    const data = parseYamlCached(matter, filePath);
    return createFrontmatterResult(data, "", matter, "yaml");
  }

  return null;
}

/**
 * Core frontmatter parsing function - V8 optimized.
 *
 * @param input - Raw file content (string or Buffer)
 * @param filePath - File path for error messages
 * @param options - Parse options (delimiters, language)
 * @returns Parsed result with data and body
 */
export function parseFrontmatter(
  input: string | Buffer,
  filePath?: string,
  options?: ParseOptions
): ParseResult;
export function parseFrontmatter(
  input: string | Buffer,
  options?: ParseOptions
): ParseResult;
export function parseFrontmatter(
  input: string | Buffer,
  filePathOrOptions?: string | ParseOptions,
  maybeOptions?: ParseOptions
): ParseResult {
  // Normalize arguments
  let filePath = "<unknown>";
  let options: ParseOptions | undefined;

  if (typeof filePathOrOptions === "string") {
    filePath = filePathOrOptions;
    options = maybeOptions;
  } else if (filePathOrOptions) {
    options = filePathOrOptions;
  }

  // Normalize input (Buffer to string, strip BOM)
  const content = normalizeInput(input);
  const len = content.length;

  // If custom delimiters provided, use the generic parser
  if (options?.delimiters) {
    return parseWithDelimiters(content, filePath, options);
  }

  // Quick rejection checks
  if (len < 7 || content.charCodeAt(0) !== CHAR_DASH) {
    return createNoFrontmatterResult(content);
  }

  // V8-optimized prefix check - FAST PATH
  if (content.startsWith("---\n")) {
    // Try empty frontmatter first
    const emptyResult = tryParseEmptyFrontmatter(content, filePath);
    if (emptyResult) return emptyResult;

    // Try standard delimiter patterns
    const standardResult = tryStandardDelimiter(content, filePath);
    if (standardResult) return standardResult;

    // Fall through to slow path for edge cases
    return parseNonStandard(content, filePath);
  }

  // Not standard format - check for edge cases
  return parseNonStandard(content, filePath);
}

// ============================================================================
// Non-Standard Path (Phase 4: Lazy Edge Case Handling)
// ============================================================================

/**
 * Find the first line ending (LF or CR) starting from position.
 * Returns { index, hasCR } or null if not found.
 */
function findFirstLineEnding(str: string, start: number): { index: number; hasCR: boolean } | null {
  for (let i = start; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === CHAR_LF) return { index: i, hasCR: false };
    if (c === CHAR_CR) return { index: i, hasCR: true };
  }
  return null;
}

/**
 * Parse language identifier from position in string.
 * Returns language and whether the delimiter is valid.
 */
function parseLanguageIdentifier(
  str: string,
  startPos: number,
  endPos: number
): { language: FrontmatterLanguage; valid: boolean } {
  // Skip leading whitespace
  let pos = startPos;
  while (pos < endPos) {
    const c = str.charCodeAt(pos);
    if (c !== CHAR_SPACE && c !== CHAR_TAB) break;
    pos++;
  }

  if (pos >= endPos) {
    // Only whitespace - valid YAML
    return { language: "yaml", valid: true };
  }

  // Find end of language identifier
  let langEnd = pos;
  while (langEnd < endPos) {
    const c = str.charCodeAt(langEnd);
    if (c === CHAR_SPACE || c === CHAR_TAB || c === CHAR_CR) break;
    langEnd++;
  }

  const langStr = str.slice(pos, langEnd).toLowerCase();
  if (langStr === "json") return { language: "json", valid: true };
  if (langStr === "yaml" || langStr === "") return { language: "yaml", valid: true };

  // Unknown language - invalid
  return { language: "yaml", valid: false };
}

/**
 * Check if the character after "---" is valid for frontmatter.
 * Returns the detected language or null if invalid.
 */
function checkDelimiterChar(
  str: string,
  char3: number,
  firstNewline: number
): { language: FrontmatterLanguage; valid: boolean } {
  // Newline or CR after --- is valid
  if (char3 === CHAR_LF || char3 === CHAR_CR) {
    return { language: "yaml", valid: true };
  }

  // Whitespace or letter might be language identifier
  const isWhitespace = char3 === CHAR_SPACE || char3 === CHAR_TAB;
  const isLetter = (char3 >= 97 && char3 <= 122) || (char3 >= 65 && char3 <= 90);

  if (isWhitespace || isLetter) {
    const startPos = isWhitespace ? 3 : 3;
    return parseLanguageIdentifier(str, startPos, firstNewline);
  }

  // Invalid character
  return { language: "yaml", valid: false };
}

/**
 * Handle non-standard formats: CRLF, CR-only, language identifiers, trailing whitespace.
 * This is the slow path, only called when standard path fails.
 * Note: BOM is already stripped in normalizeInput.
 */
function parseNonStandard(content: string, filePath: string): ParseResult {
  // If doesn't start with ---, no frontmatter
  if (!content.startsWith("---")) {
    return createNoFrontmatterResult(content);
  }

  // Find first line ending
  const lineEnding = findFirstLineEnding(content, 3);
  if (!lineEnding) {
    return createNoFrontmatterResult(content);
  }

  // Check character after "---" and detect language
  const char3 = content.charCodeAt(3);
  const delimResult = checkDelimiterChar(content, char3, lineEnding.index);
  if (!delimResult.valid) {
    return createNoFrontmatterResult(content);
  }
  const language = delimResult.language;

  // Normalize CR and CRLF to LF if needed
  const str = lineEnding.hasCR ? content.replace(/\r\n?/g, "\n") : content;

  // Re-find first newline after normalization
  const normalizedFirstNewline = str.indexOf("\n", 3);
  if (normalizedFirstNewline === -1) {
    return createNoFrontmatterResult(content);
  }

  // Find closing delimiter
  const searchStart = normalizedFirstNewline + 1;
  const closeResult = findClosingDelimiter(str, searchStart);

  if (!closeResult) {
    return {
      data: EMPTY_DATA,
      body: str.slice(searchStart),
      matter: "",
      hasFrontmatter: false,
      language,
    };
  }

  // Extract matter and body
  const matter = str.slice(searchStart, closeResult.matterEnd);
  let body = str.slice(closeResult.bodyStart);

  // Trim leading newline from body
  if (body.charCodeAt(0) === CHAR_LF) {
    body = body.slice(1);
  }

  // Handle empty frontmatter
  if (matter.length === 0 || isBlank(matter)) {
    return createFrontmatterResult(EMPTY_DATA, body, "", language);
  }

  // Parse with appropriate engine
  const data =
    language === "json"
      ? parseJsonFrontmatter(matter, filePath)
      : parseYamlCached(matter, filePath);

  return createFrontmatterResult(data, body, matter, language);
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Fast path check for common delimiter patterns.
 * Returns result or null if not found.
 */
function findCommonDelimiter(
  str: string,
  searchStart: number
): { matterEnd: number; bodyStart: number } | null {
  const len = str.length;

  // Look for exact '\n---\n' pattern (most common)
  let idx = str.indexOf("\n---\n", searchStart - 1);
  if (idx !== -1 && idx >= searchStart - 1) {
    return { matterEnd: idx + 1, bodyStart: idx + 5 };
  }

  // Try '\n...\n' (YAML document end)
  idx = str.indexOf("\n...\n", searchStart - 1);
  if (idx !== -1 && idx >= searchStart - 1) {
    return { matterEnd: idx + 1, bodyStart: idx + 5 };
  }

  // End-of-string variants
  if (str.endsWith("\n---")) {
    return { matterEnd: len - 3, bodyStart: len };
  }
  if (str.endsWith("\n...")) {
    return { matterEnd: len - 3, bodyStart: len };
  }

  return null;
}

/**
 * Slow path: line-by-line search for delimiters with trailing whitespace.
 */
function findDelimiterWithWhitespace(
  str: string,
  searchStart: number
): { matterEnd: number; bodyStart: number } | null {
  const len = str.length;
  let lineStart = searchStart;

  while (lineStart < len) {
    let lineEnd = lineStart;
    while (lineEnd < len && str.charCodeAt(lineEnd) !== CHAR_LF) {
      lineEnd++;
    }

    if (isClosingDelimiter(str, lineStart, lineEnd)) {
      return {
        matterEnd: lineStart,
        bodyStart: lineEnd < len ? lineEnd + 1 : lineEnd,
      };
    }

    if (lineEnd >= len) break;
    lineStart = lineEnd + 1;
  }

  return null;
}

/**
 * Find closing delimiter using optimized search.
 */
function findClosingDelimiter(
  str: string,
  searchStart: number
): { matterEnd: number; bodyStart: number } | null {
  // Try fast path first
  const common = findCommonDelimiter(str, searchStart);
  if (common) return common;

  // Fall back to slow path
  return findDelimiterWithWhitespace(str, searchStart);
}

/**
 * Check if a line is a valid closing delimiter (--- or ...).
 * Allows trailing whitespace.
 */
function isClosingDelimiter(str: string, start: number, end: number): boolean {
  const lineLen = end - start;
  if (lineLen < 3) return false;

  const c0 = str.charCodeAt(start);
  const c1 = str.charCodeAt(start + 1);
  const c2 = str.charCodeAt(start + 2);

  // Check for '---' or '...'
  const isDashes = c0 === CHAR_DASH && c1 === CHAR_DASH && c2 === CHAR_DASH;
  const isDots = c0 === CHAR_DOT && c1 === CHAR_DOT && c2 === CHAR_DOT;

  if (!isDashes && !isDots) return false;

  // Rest must be whitespace only
  for (let i = start + 3; i < end; i++) {
    const c = str.charCodeAt(i);
    if (c !== CHAR_SPACE && c !== CHAR_TAB && c !== CHAR_CR) {
      return false;
    }
  }

  return true;
}

/**
 * Fast blank check without creating a trimmed string.
 */
function isBlank(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c !== CHAR_SPACE && c !== CHAR_TAB && c !== CHAR_LF && c !== CHAR_CR) {
      return false;
    }
  }
  return true;
}

// ============================================================================
// Parser Implementations
// ============================================================================

/**
 * Standard frontmatter parser for markdown files.
 * Extracts YAML frontmatter and returns both data and content.
 */
export const frontmatterParser: Parser = {
  name: "frontmatter",
  extensions: ["md", "mdx", "markdown"],
  hasContent: true,

  parse(content: string, filePath: string): ParseOutput {
    const result = parseFrontmatter(content, filePath);
    return {
      data: result.data,
      content: result.body,
    };
  },
};

/**
 * Frontmatter-only parser that discards the body content.
 * Useful when you only need metadata and want to skip body processing.
 */
export const frontmatterOnlyParser: Parser = {
  name: "frontmatter-only",
  extensions: ["md", "mdx", "markdown"],
  hasContent: false,

  parse(content: string, filePath: string): ParseOutput {
    const result = parseFrontmatter(content, filePath);
    return {
      data: result.data,
      content: "", // Discard body
    };
  },
};

// ============================================================================
// Helper Functions (Gray-matter API Compatibility)
// ============================================================================

/**
 * Detect the language specified in the frontmatter delimiter.
 * Returns the language identifier (e.g., "yaml", "json") or undefined if not detectable.
 *
 * @param input - Raw file content (string or Buffer)
 * @param delimiter - Opening delimiter to look for (default: "---")
 * @returns The detected language or undefined
 */
export function detectLanguage(
  input: string | Buffer,
  delimiter: string = "---"
): FrontmatterLanguage | undefined {
  const content = normalizeInput(input);

  if (!content.startsWith(delimiter)) {
    return undefined;
  }

  const delimLen = delimiter.length;
  const firstNewline = content.indexOf("\n", delimLen);
  if (firstNewline === -1) {
    return undefined;
  }

  // Extract text after delimiter
  const afterDelim = content.slice(delimLen, firstNewline).trim().toLowerCase();

  if (!afterDelim || afterDelim === "yaml" || afterDelim === "yml") {
    return "yaml";
  }
  if (afterDelim === "json") {
    return "json";
  }

  // Check if it's just whitespace (valid YAML frontmatter)
  const char = content.charCodeAt(delimLen);
  if (char === CHAR_LF || char === CHAR_CR || char === CHAR_SPACE || char === CHAR_TAB) {
    return "yaml";
  }

  return undefined;
}

/**
 * Quick test if content has frontmatter (without full parsing).
 * Optimized for fast rejection of content without frontmatter.
 *
 * @param content - Raw file content
 * @returns true if content appears to have valid frontmatter
 */
export function hasFrontmatter(content: string): boolean {
  if (content.length < 4) return false;

  let offset = 0;
  let c0 = content.charCodeAt(0);

  // Check for BOM
  if (c0 === CHAR_BOM) {
    offset = 1;
    c0 = content.charCodeAt(1);
  }

  // Check starts with '-'
  if (c0 !== CHAR_DASH) return false;

  // Check for '---'
  if (
    content.charCodeAt(offset + 1) !== CHAR_DASH ||
    content.charCodeAt(offset + 2) !== CHAR_DASH
  ) {
    return false;
  }

  // Check has valid delimiter ending (newline, CR, whitespace, or language identifier)
  const char3 = content.charCodeAt(offset + 3);

  // Direct newline or CR - valid
  if (char3 === CHAR_LF || char3 === CHAR_CR) {
    return true;
  }

  // Trailing whitespace - valid
  if (char3 === CHAR_SPACE || char3 === CHAR_TAB) {
    return true;
  }

  // Check if it could be a language identifier (e.g., "---json")
  if (
    (char3 >= 97 && char3 <= 122) || // a-z
    (char3 >= 65 && char3 <= 90) || // A-Z
    (char3 >= 48 && char3 <= 57) // 0-9
  ) {
    const newlinePos = content.indexOf("\n", offset + 4);
    return newlinePos !== -1;
  }

  return false;
}

/**
 * Convert data back to frontmatter string.
 *
 * @param data - Data object to stringify
 * @param content - Optional body content to append
 * @param options - Stringify options
 * @returns Formatted frontmatter string with content
 */
export function stringify(
  data: Record<string, unknown>,
  content: string = "",
  options: { language?: FrontmatterLanguage; delimiters?: [string, string] } = {}
): string {
  const language = options.language || "yaml";
  const [open, close] = options.delimiters || ["---", "---"];
  const engine = engines[language];

  if (!engine?.stringify) {
    throw new Error(`Stringify not supported for language: ${language}`);
  }

  const matter = engine.stringify(data).trim();

  // Handle empty/null data
  if (!matter || matter === "{}" || matter === "null") {
    return content;
  }

  // Build result with proper formatting
  const parts = [open];
  if (language !== "yaml") {
    parts[0] = `${open}${language}`;
  }
  parts.push("\n", matter, "\n", close, "\n");
  if (content) {
    parts.push(content);
  }

  return parts.join("");
}

/**
 * Extract excerpt from parsed result using a separator.
 *
 * @param result - Parsed frontmatter result
 * @param separator - Excerpt separator (default: "---")
 * @returns Result with excerpt extracted
 */
export function extractExcerpt(
  result: ParseResult,
  separator: string = "---"
): ParseResult & { excerpt: string } {
  const idx = result.body.indexOf(separator);

  if (idx === -1) {
    return { ...result, excerpt: "" };
  }

  return {
    ...result,
    excerpt: result.body.slice(0, idx).trim(),
    body: result.body.slice(idx + separator.length).trim(),
  };
}

// ============================================================================
// Content-Level Caching (Phase 5: Optional for batch operations)
// ============================================================================

const contentCache = new Map<string, WeakRef<ParseResult>>();
const finalizationRegistry = new FinalizationRegistry((key: string) => {
  contentCache.delete(key);
});

/**
 * Parse frontmatter with content-level caching.
 * Useful for batch processing where identical content may be parsed repeatedly.
 *
 * @param input - Raw file content (string or Buffer)
 * @param filePath - File path for error messages
 * @returns Parsed result with data and body
 */
export function parseFrontmatterCached(
  input: string | Buffer,
  filePath: string = "<unknown>"
): ParseResult {
  // Normalize input to string for cache key
  const content = normalizeInput(input);

  // Check content cache
  const cached = contentCache.get(content);
  if (cached) {
    const result = cached.deref();
    if (result) {
      return result;
    }
  }

  // Parse normally (content is already normalized, so pass it directly)
  const result = parseFrontmatter(content, filePath);

  // Cache if content is not too large (avoid memory bloat)
  if (content.length < 50000) {
    const ref = new WeakRef(result);
    contentCache.set(content, ref);
    finalizationRegistry.register(result, content);
  }

  return result;
}

/**
 * Clear the content-level cache.
 */
export function clearContentCache(): void {
  contentCache.clear();
}
