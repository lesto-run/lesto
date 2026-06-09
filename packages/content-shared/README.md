# @keel/content-shared

Shared utilities for the Docks monorepo. Provides common functionality for error handling, caching, security, validation, and more.

## Installation

```bash
pnpm add @keel/content-shared
```

## Modules

### Errors (`@keel/content-shared/errors`)

Structured error classes with context for debugging and logging.

```typescript
import {
  DocksError,
  ValidationError,
  ParseError,
  NetworkError,
  SecurityError,
  ConfigError,
  Result,
  ok,
  err,
  isOk,
  isErr,
  unwrap,
  unwrapOr,
} from "@keel/content-shared/errors";

// Throw typed errors with context
throw new ValidationError("Invalid email format", { field: "email", value });

// Use Result type for recoverable errors
function parseConfig(input: string): Result<Config, ParseError> {
  try {
    return ok(JSON.parse(input));
  } catch (e) {
    return err(new ParseError("Invalid JSON", { line: 1 }));
  }
}

const result = parseConfig(input);
if (isOk(result)) {
  console.log(result.data);
} else {
  console.error(result.error.message);
}
```

### Sanitize (`@keel/content-shared/sanitize`)

Security utilities for preventing XSS, prototype pollution, and path traversal.

```typescript
import {
  sanitizeHtml,
  sanitizeJsonLd,
  serializeJsonLd,
  sanitizeObject,
  sanitizePath,
  isDangerousHtml,
} from "@keel/content-shared/sanitize";

// Sanitize user-generated HTML
const safeHtml = sanitizeHtml('<script>alert("xss")</script><p>Hello</p>');
// => "<p>Hello</p>"

// Serialize JSON-LD safely for embedding in <script> tags
const schema = { "@type": "Article", headline: "Test" };
const safeJson = serializeJsonLd(schema);

// Prevent prototype pollution
const safeObj = sanitizeObject(untrustedInput);

// Prevent path traversal
const safePath = sanitizePath("../../../etc/passwd", "/app/content");
// => Throws SecurityError
```

### Cache (`@keel/content-shared/cache`)

LRU caching with configurable limits, TTL, and memory management.

```typescript
import {
  createCache,
  createImmutableCache,
  createWeakCache,
  deepClone,
  CACHE_LIMITS,
  CACHE_TTL,
} from "@keel/content-shared/cache";

// Create a basic LRU cache
const cache = createCache<User>({
  max: CACHE_LIMITS.TRANSFORM_CONTEXT,
  ttl: CACHE_TTL.MEDIUM,
});

cache.set("user:123", user);
const cached = cache.get("user:123");

// Create an immutable cache that clones on get/set
const yamlCache = createImmutableCache<Record<string, unknown>>(
  { max: CACHE_LIMITS.YAML_PARSE },
  deepClone
);

// Create a WeakRef-based cache for automatic GC
const weakCache = createWeakCache<LargeObject>();
```

### Mutex (`@keel/content-shared/mutex`)

Async synchronization primitives for preventing race conditions.

```typescript
import {
  AsyncMutex,
  ReadWriteLock,
  createSingletonLoader,
  createDebouncedAsync,
} from "@keel/content-shared/mutex";

// Protect critical sections
const mutex = new AsyncMutex();
await mutex.runExclusive(async () => {
  await writeToDatabase();
});

// Read-write lock for concurrent reads, exclusive writes
const rwLock = new ReadWriteLock();
const releaseRead = await rwLock.acquireRead();
// ... read operations
releaseRead();

// Prevent duplicate initialization
const loadConfig = createSingletonLoader(async () => {
  return await fetchConfig();
});

// Debounce with proper cancellation
const debouncedSave = createDebouncedAsync(saveData, 500);
await debouncedSave(data);
debouncedSave.cancel(); // Cancel pending call
await debouncedSave.flush(); // Execute immediately
```

### Validation (`@keel/content-shared/validation`)

Input validation with Zod schemas and type-safe validators.

```typescript
import {
  validateUrl,
  validatePagination,
  validateSlug,
  validateRange,
  validateNotEmpty,
  createValidator,
  paginationSchema,
  slugSchema,
  entrySchema,
} from "@keel/content-shared/validation";

// Validate URLs
const url = validateUrl("https://example.com", "API endpoint");

// Validate pagination params
const params = validatePagination({ limit: 20, offset: 0 });

// Validate slugs
const slug = validateSlug("my-article-slug");

// Create custom validators from Zod schemas
const validateUser = createValidator(userSchema, "user");
const user = validateUser(input);
```

### Encoding (`@keel/content-shared/encoding`)

Base64 encoding and binary utilities for embeddings and search.

```typescript
import {
  encodeBase64,
  decodeBase64,
  encodeFloat32Array,
  decodeFloat32Array,
  popcount,
  hammingDistance,
} from "@keel/content-shared/encoding";

// Encode/decode base64 (works in Node.js and browser)
const base64 = encodeBase64(bytes);
const decoded = decodeBase64(base64);

// Handle Float32Array for embeddings
const floats = new Float32Array([1.0, 2.0, 3.0]);
const encoded = encodeFloat32Array(floats);
const restored = decodeFloat32Array(encoded);

// Binary similarity with Hamming distance
const distance = hammingDistance(hash1, hash2);
```

### Slugify (`@keel/content-shared/slugify`)

GitHub-compatible slug generation for headings and URLs.

```typescript
import {
  slugify,
  slugifyOnce,
  createSlugger,
  resetSlugger,
} from "@keel/content-shared/slugify";

// Generate a slug
const slug = slugifyOnce("Hello World"); // => "hello-world"

// Handle duplicate headings
const slugger = createSlugger();
slugger.slug("Introduction"); // => "introduction"
slugger.slug("Introduction"); // => "introduction-1"
resetSlugger(slugger);
```

### XML (`@keel/content-shared/xml`)

XML and RSS utilities for feeds and sitemaps.

```typescript
import {
  escapeXml,
  decodeXml,
  escapeXmlAttr,
  wrapCdata,
  formatXmlDate,
  formatRssDate,
} from "@keel/content-shared/xml";

// Escape XML content
const safe = escapeXml("<script>"); // => "&lt;script&gt;"

// Create CDATA sections
const cdata = wrapCdata("Content with ]]> inside");

// Format dates for XML/RSS
const isoDate = formatXmlDate(new Date()); // ISO 8601
const rssDate = formatRssDate(new Date()); // RFC 822
```

### Shutdown (`@keel/content-shared/shutdown`)

Graceful shutdown management for long-running processes.

```typescript
import {
  GracefulShutdown,
  onProcessExit,
  createShutdownTimeout,
} from "@keel/content-shared/shutdown";

// Full shutdown management
const shutdown = new GracefulShutdown({ timeout: 10000 });

shutdown.onShutdown(async () => {
  await database.close();
});

// Track operations that should complete before shutdown
await shutdown.track(importantOperation());

// Setup signal handlers
GracefulShutdown.setupSignalHandlers(shutdown);

// Simple cleanup registration
onProcessExit(async () => {
  await cleanup();
});
```

### Markdown (`@keel/content-shared/markdown`)

Markdown parsing utilities (requires optional peer dependencies).

```typescript
import {
  extractPlainText,
  extractHeadings,
  stripFrontmatter,
  hasFrontmatter,
  calculateReadingTime,
} from "@keel/content-shared/markdown";

// Extract plain text from markdown
const text = await extractPlainText("# Hello **world**");

// Extract headings with slugs
const headings = await extractHeadings(markdown, [1, 2, 3]);
// => [{ depth: 1, text: "Introduction", slug: "introduction" }]

// Handle frontmatter
if (hasFrontmatter(content)) {
  const body = stripFrontmatter(content);
}

// Calculate reading time
const { minutes, words, text } = await calculateReadingTime(markdown);
```

## Cache Limits

Standard cache limits are provided for consistency across packages:

| Constant | Value | Use Case |
|----------|-------|----------|
| `TRANSFORM_CONTEXT` | 500 | Context cache for typical doc sites |
| `YAML_PARSE` | 1000 | Frontmatter parsing |
| `SEARCH_INDEX` | 10 | Memory-heavy search indexes |
| `EMBEDDINGS` | 100 | Embedding vectors (~1.5KB each) |
| `LINT_PARAGRAPH` | 200 | Lint diagnostics per paragraph |
| `LINT_DB` | 1000 | Lint cache DB entries |

## TTL Values

Standard time-to-live values:

| Constant | Duration | Use Case |
|----------|----------|----------|
| `SHORT` | 5 minutes | Frequently changing data |
| `MEDIUM` | 1 hour | Session-length caching |
| `LONG` | 1 day | Rarely changing data |
| `PERSISTENT` | 1 week | Build artifacts |

## Peer Dependencies

The `markdown` module requires optional peer dependencies:

```bash
pnpm add unified remark-parse unist-util-visit mdast-util-to-string
```

## License

MIT
