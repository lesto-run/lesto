# @usedocks/mcp Code Review

## Executive Summary

This package provides MCP (Model Context Protocol) server implementations for the Docks content engine. It includes two server implementations: a standalone server (`server.ts`) that operates directly on the filesystem, and an HTTP server (`http.ts`) that wraps a Studio API. The package also provides an HTTP client (`client.ts`) for communicating with the Studio API.

**Overall Assessment**: The codebase is functional but has several architectural issues, code duplication, missing error handling patterns, and opportunities to better leverage the MCP SDK's higher-level APIs. The implementation uses the deprecated `Server` class instead of the newer `McpServer` class, misses critical edge cases, and has inconsistent patterns that could lead to production issues.

---

## Critical Issues

### 1. Using Deprecated MCP SDK API

**Location**: `src/server.ts:5`, `src/http.ts:11`

**Issue**: The code imports and uses the deprecated `Server` class directly instead of the higher-level `McpServer` class that the SDK recommends.

```typescript
// Current (deprecated)
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

// SDK types.d.ts explicitly states:
// @deprecated Use `McpServer` instead for the high-level API. Only use `Server` for advanced use cases.
```

**Impact**:
- Missing built-in input/output validation
- Manual request handler setup instead of declarative tool registration
- No access to `registerTool()`, `registerResource()`, `registerPrompt()` methods
- Missing automatic task support features

**Recommendation**: Migrate to `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const server = new McpServer({
  name: "docks",
  version: "0.1.0"
});

// Declarative tool registration with built-in validation
server.registerTool("list_collections", {
  description: "List all content collections...",
  inputSchema: z.object({}).strict()
}, async (args, extra) => {
  // handler
});
```

---

### 2. No Input Validation on Tool Arguments

**Location**: `src/server.ts:502-506`, `src/http.ts:967-971`

**Issue**: Tool arguments are passed directly to handlers without validation against the Zod schemas defined in the tool definitions.

```typescript
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  // args is passed directly without validation!
  const result = await handleToolCall(engine, config, name, args ?? {});
```

**Impact**:
- Malformed requests could crash handlers or cause undefined behavior
- Type assertions in handlers (`args as { collection: string }`) are unsafe
- No schema-based validation means relying on runtime type checks

**Recommendation**: Validate against tool input schemas before dispatch:

```typescript
const tool = TOOLS.find(t => t.name === name);
if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };

// Validate with the tool's inputSchema
const schema = getZodSchemaForTool(name);
const parseResult = schema.safeParse(args);
if (!parseResult.success) {
  return {
    content: [{ type: "text", text: `Invalid arguments: ${parseResult.error.message}` }],
    isError: true
  };
}
```

---

### 3. Concurrent Tool Call Race Conditions

**Location**: `src/server.ts:470-532`, `src/http.ts:916-1003`

**Issue**: The MCP server maintains mutable state (engine, config, client) that is shared across all concurrent tool calls without any synchronization.

```typescript
// Engine state could be modified during concurrent file operations
async function handleCreateEntry(engine: Engine, config: ResolvedConfig, args) {
  // These operations are not atomic:
  const existing = engine.getEntry(args.collection, slug);  // Check
  if (existing) return "Error: Entry already exists";
  // ... time passes, another call could create entry here ...
  await writeFile(filePath, fileContent, "utf-8");  // Write
}
```

**Impact**:
- TOCTOU (time-of-check-time-of-use) race conditions on create/update operations
- Concurrent searches could return inconsistent results if engine state changes
- No guarantee of read-after-write consistency

**Recommendation**: Implement operation locking or use atomic operations:

```typescript
import { Mutex } from 'async-mutex';

const writeMutex = new Mutex();

async function handleCreateEntry(...) {
  return writeMutex.runExclusive(async () => {
    const existing = engine.getEntry(args.collection, slug);
    if (existing) return "Error: Entry already exists";
    await writeFile(filePath, fileContent, "utf-8");
    await engine.scan(); // Re-scan to update cache
    return `Successfully created entry at ${filePath}`;
  });
}
```

---

## High Severity Issues

### 4. Missing Engine State Refresh

**Location**: `src/server.ts:345-349`, `src/server.ts:410-415`

**Issue**: After creating or updating entries, the engine cache is not refreshed. The engine only scans once at startup.

```typescript
export async function createMcpServer(options: McpServerOptions = {}): Promise<Server> {
  // Scan only happens once at startup
  await engine.scan();
  // ... server runs indefinitely without re-scanning
}

async function handleCreateEntry(...): Promise<string> {
  await writeFile(filePath, fileContent, "utf-8");
  // Engine cache is now stale!
  return `Successfully created entry at ${filePath}`;
}
```

**Impact**:
- `list_collections`, `get_entry`, `search_content` will return stale data
- Users cannot see their newly created entries
- Inconsistent state between filesystem and engine

**Recommendation**: Re-scan affected collections after mutations:

```typescript
async function handleCreateEntry(...): Promise<string> {
  await writeFile(filePath, fileContent, "utf-8");
  await engine.scanCollection(args.collection); // or engine.scan() for full refresh
  return `Successfully created entry at ${filePath}`;
}
```

---

### 5. Unbounded Search in HTTP Server

**Location**: `src/http.ts:455-495`

**Issue**: The HTTP search implementation fetches every entry individually with N+1 queries, with no parallelization or caching.

```typescript
async function handleSearchContent(client: McpClient, args) {
  outer: for (const col of collections) {
    for (const entry of col.entries) {
      // Individual HTTP request for EACH entry!
      const entryResponse = await client.get<EntryInfo>(
        `/api/collections/${col.name}/${entry.slug}`
      );
      // ...
    }
  }
}
```

**Impact**:
- O(n) HTTP requests where n is total entries
- Extremely slow for large collections
- No timeout protection for search operations
- Could timeout or OOM with large content bodies

**Recommendation**: Implement server-side search endpoint or batch fetching:

```typescript
// Better: Use a dedicated search endpoint
async function handleSearchContent(client: McpClient, args) {
  const response = await client.get<SearchResponse>(
    `/api/search?q=${encodeURIComponent(args.query)}&limit=${args.limit}&collection=${args.collection ?? ''}`
  );
  return JSON.stringify(response.data, null, 2);
}

// Alternative: Parallel fetch with concurrency limit
import pLimit from 'p-limit';
const limit = pLimit(5); // Max 5 concurrent requests

const entryPromises = col.entries.map(entry =>
  limit(() => client.get<EntryInfo>(`/api/collections/${col.name}/${entry.slug}`))
);
const entries = await Promise.all(entryPromises);
```

---

### 6. Timeout Not Applied to AbortController Correctly

**Location**: `src/client.ts:84-99`

**Issue**: The timeout cleanup happens after `fetch` completes, but if `fetch` succeeds before timeout, the abort signal is still set to abort which could affect subsequent operations using the same signal.

```typescript
private async fetchWithRetry(url: string, options: RequestInit, retriesLeft: number): Promise<Response> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    const response = await fetch(url, {
      ...options,
      signal: controller.signal,  // This replaces any signal from options!
    });

    clearTimeout(timeoutId);
    return response;
  }
```

**Impact**:
- Any signal in `options` is overwritten
- Memory leak potential if clearTimeout is not reached due to exceptions

**Recommendation**: Use `AbortSignal.timeout()` or compose signals properly:

```typescript
private async fetchWithRetry(url: string, options: RequestInit, retriesLeft: number): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(this.timeout);

  // Compose with any existing signal
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  try {
    return await fetch(url, { ...options, signal });
  } catch (error) {
    // Handle errors...
  }
}
```

---

### 7. Singleton Client State Mutation Bug

**Location**: `src/client.ts:274-282`

**Issue**: The singleton pattern for `getMcpClient` has a bug where passing new options doesn't always create a new client.

```typescript
let defaultClient: McpClient | null = null;

export function getMcpClient(options?: McpClientOptions): McpClient {
  if (!defaultClient || options) {  // Bug: options could be {}
    defaultClient = new McpClient(options);
  }
  return defaultClient;
}
```

**Impact**:
- `getMcpClient({})` creates a new client, overwriting the previous
- Calling `getMcpClient()` after `getMcpClient({ debug: true })` returns the debug client
- No way to reset or get a fresh non-default client

**Recommendation**: Separate singleton from factory:

```typescript
let defaultClient: McpClient | null = null;

export function getDefaultMcpClient(): McpClient {
  if (!defaultClient) {
    defaultClient = new McpClient();
  }
  return defaultClient;
}

export function createMcpClient(options: McpClientOptions): McpClient {
  return new McpClient(options);
}

// For backwards compatibility
export function getMcpClient(options?: McpClientOptions): McpClient {
  return options ? createMcpClient(options) : getDefaultMcpClient();
}
```

---

## Medium Severity Issues

### 8. Massive Code Duplication Between server.ts and http.ts

**Location**: `src/server.ts:25-76`, `src/http.ts:35-86`

**Issue**: The `zodToMcpSchema` function and `ToolBuilder` class are duplicated verbatim between files.

```typescript
// Identical in both files:
function zodToMcpSchema(schema: z.ZodType): { ... }
class ToolBuilder { ... }
```

**Impact**:
- Maintenance burden - fixes must be applied twice
- Inconsistency risk if one is updated and not the other
- Violates DRY principle

**Recommendation**: Extract shared utilities to a common module:

```typescript
// src/utils/schema.ts
export function zodToMcpSchema(schema: z.ZodType) { ... }

// src/utils/tool-builder.ts
export class ToolBuilder { ... }

// src/server.ts
import { zodToMcpSchema } from "./utils/schema.js";
import { ToolBuilder } from "./utils/tool-builder.js";
```

---

### 9. Partial Tool Definitions Duplicated

**Location**: `src/server.ts:79-161`, `src/http.ts:89-182`

**Issue**: Content tool definitions (list_collections, get_entry, etc.) are defined identically in both files.

**Recommendation**: Define shared tool schemas once:

```typescript
// src/tools/schemas.ts
export const CONTENT_TOOL_SCHEMAS = {
  list_collections: z.object({}),
  get_collection_schema: z.object({
    collection: z.string().describe("The name of the collection"),
  }),
  // ...
} as const;

// src/tools/definitions.ts
export const CONTENT_TOOLS = Object.entries(CONTENT_TOOL_SCHEMAS).map(
  ([name, schema]) => ToolBuilder.create(name)
    .description(TOOL_DESCRIPTIONS[name])
    .params(schema)
    .build()
);
```

---

### 10. Unsafe Type Assertions Throughout

**Location**: `src/server.ts:425-457`, `src/http.ts:833-904`

**Issue**: Handler registries use unsafe type assertions that bypass TypeScript's type checking.

```typescript
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  get_entry: (engine, _, args) =>
    handleGetEntry(engine, args as { collection: string; slug: string }),
  //                        ^^^^ Unsafe assertion
```

**Impact**:
- Runtime errors if arguments don't match expected shape
- TypeScript won't catch type mismatches
- Maintenance hazard when adding new parameters

**Recommendation**: Use Zod validation and type inference:

```typescript
const getEntrySchema = z.object({
  collection: z.string(),
  slug: z.string(),
});

type GetEntryArgs = z.infer<typeof getEntrySchema>;

const TOOL_HANDLERS = {
  get_entry: (engine, _, args) => {
    const parsed = getEntrySchema.parse(args);
    return handleGetEntry(engine, parsed);
  },
} satisfies Record<string, ToolHandler>;
```

---

### 11. Missing Error Boundaries in Stream Handler

**Location**: `src/client.ts:214-271`

**Issue**: The SSE stream handler has minimal error handling and doesn't handle malformed data gracefully.

```typescript
async *stream(path: string, body: unknown): AsyncGenerator<string, void, unknown> {
  // ...
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const data = line.slice(6);
      if (data === "[DONE]") return;
      yield data;  // What if this is malformed JSON?
    }
  }
}
```

**Impact**:
- Malformed SSE data could break consumers expecting JSON
- No reconnection logic for dropped connections
- No handling for SSE comments or other event types

**Recommendation**: Add robust SSE parsing:

```typescript
async *stream(path: string, body: unknown): AsyncGenerator<{event?: string; data: string}, void, unknown> {
  // ...
  let event: string | undefined;

  for (const line of lines) {
    if (line === '') {
      // Empty line = event dispatch
      continue;
    }
    if (line.startsWith(':')) {
      // Comment, ignore
      continue;
    }
    if (line.startsWith('event: ')) {
      event = line.slice(7);
      continue;
    }
    if (line.startsWith('data: ')) {
      const data = line.slice(6);
      if (data === '[DONE]') return;
      yield { event, data };
      event = undefined;
    }
  }
}
```

---

### 12. No Graceful Shutdown for Long-Running Operations

**Location**: `src/server.ts:542-550`, `src/http.ts:1013-1021`

**Issue**: Signal handlers call `server.close()` and immediately exit, potentially interrupting in-flight operations.

```typescript
process.on("SIGINT", async () => {
  await server.close();  // What about pending tool calls?
  process.exit(0);
});
```

**Impact**:
- File writes could be interrupted mid-operation
- HTTP requests could be abandoned
- Data corruption possible

**Recommendation**: Implement graceful shutdown with operation tracking:

```typescript
const activeOperations = new Set<Promise<unknown>>();

function trackOperation<T>(op: Promise<T>): Promise<T> {
  activeOperations.add(op);
  return op.finally(() => activeOperations.delete(op));
}

process.on("SIGINT", async () => {
  console.error("[MCP] Shutting down gracefully...");

  // Stop accepting new connections
  await server.close();

  // Wait for active operations (with timeout)
  const timeout = setTimeout(() => {
    console.error("[MCP] Forcing shutdown after timeout");
    process.exit(1);
  }, 5000);

  await Promise.all(activeOperations);
  clearTimeout(timeout);
  process.exit(0);
});
```

---

## Low Severity Issues

### 13. Hardcoded Server Version

**Location**: `src/server.ts:488-489`, `src/http.ts:941-945`

**Issue**: Server version is hardcoded instead of reading from package.json.

```typescript
const server = new Server(
  {
    name: "docks",
    version: "0.1.0",  // Should match package.json
  },
```

**Recommendation**: Import version from package.json:

```typescript
import { version } from '../package.json' with { type: 'json' };
// or
const { version } = await import('../package.json', { with: { type: 'json' } });
```

---

### 14. Inconsistent Error Response Format

**Location**: Various handler functions

**Issue**: Error messages have inconsistent formats across handlers:

```typescript
// Some return plain strings
return `Error: ${response.error}`;

// Some return JSON
return JSON.stringify({ configured: false, error: response.error }, null, 2);

// Some return structured messages
return `Error: Collection "${args.collection}" not found. Available collections: ${available}`;
```

**Recommendation**: Standardize error response format:

```typescript
interface ToolError {
  error: true;
  code: string;
  message: string;
  details?: unknown;
}

function createError(code: string, message: string, details?: unknown): string {
  return JSON.stringify({ error: true, code, message, details }, null, 2);
}

// Usage
return createError('COLLECTION_NOT_FOUND', `Collection "${args.collection}" not found`, {
  availableCollections: available
});
```

---

### 15. Missing JSDoc on Public API

**Location**: `src/index.ts` exports

**Issue**: Public exports lack comprehensive JSDoc documentation for consumers.

**Recommendation**: Add thorough documentation:

```typescript
/**
 * Creates a standalone MCP server that loads content directly from the filesystem.
 *
 * @param options - Server configuration options
 * @param options.cwd - Working directory containing docks.config.ts (defaults to process.cwd())
 * @returns Promise resolving to a configured Server instance
 *
 * @example
 * ```typescript
 * const server = await createMcpServer({ cwd: '/path/to/project' });
 * const transport = new StdioServerTransport();
 * await server.connect(transport);
 * ```
 */
export async function createMcpServer(options?: McpServerOptions): Promise<Server>
```

---

### 16. Magic Numbers and Strings

**Location**: `src/client.ts:59`, `src/client.ts:72`, `src/server.ts:120-121`

**Issue**: Various magic numbers and strings scattered throughout:

```typescript
signal: AbortSignal.timeout(2000),  // Why 2000?
const checkInterval = 500;  // Why 500?
.describe("Maximum number of results (default: 10)"),  // Document this constant
```

**Recommendation**: Extract to named constants:

```typescript
const HEALTH_CHECK_TIMEOUT_MS = 2000;
const STUDIO_POLL_INTERVAL_MS = 500;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 100;
```

---

## Library Recommendations

### 1. Use `McpServer` Instead of `Server`

**Current**: `@modelcontextprotocol/sdk/server/index.js` (deprecated `Server` class)
**Recommended**: `@modelcontextprotocol/sdk/server/mcp.js` (`McpServer` class)

**Rationale**:
- Higher-level, declarative API
- Built-in input/output validation
- Better TypeScript integration
- Automatic Zod schema support
- Future-proof as the SDK evolves

### 2. Add `async-mutex` for Concurrency Control

**Package**: `async-mutex`
**Purpose**: Prevent race conditions in file operations

```typescript
import { Mutex, Semaphore } from 'async-mutex';

const fileMutex = new Mutex();
const apiSemaphore = new Semaphore(5); // Limit concurrent API calls
```

### 3. Add `p-limit` for Controlled Parallelism

**Package**: `p-limit`
**Purpose**: Control concurrent HTTP requests in search

```typescript
import pLimit from 'p-limit';

const limit = pLimit(5);
const results = await Promise.all(
  entries.map(e => limit(() => fetchEntry(e)))
);
```

### 4. Consider `zod-validation-error` for Better Error Messages

**Package**: `zod-validation-error`
**Purpose**: Human-readable validation error messages

```typescript
import { fromZodError } from 'zod-validation-error';

const result = schema.safeParse(input);
if (!result.success) {
  const error = fromZodError(result.error);
  return `Validation error: ${error.message}`;
}
```

### 5. Add `pretty-ms` for Human-Readable Durations

**Package**: `pretty-ms`
**Purpose**: Better timeout/duration logging

```typescript
import prettyMs from 'pretty-ms';
console.log(`Request timed out after ${prettyMs(timeout)}`);
```

---

## Architecture Recommendations

### 1. Extract Tool Handler Registry

Create a proper tool registry that handles:
- Tool definition with schema
- Input validation
- Handler execution
- Error formatting

```typescript
// src/tools/registry.ts
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register<T extends z.ZodType>(
    name: string,
    schema: T,
    handler: (args: z.infer<T>) => Promise<ToolResult>
  ) {
    this.tools.set(name, { name, schema, handler });
  }

  async execute(name: string, args: unknown): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolNotFoundError(name);

    const validated = tool.schema.parse(args);
    return tool.handler(validated);
  }
}
```

### 2. Implement Repository Pattern for Content

Separate data access from handlers:

```typescript
// src/repositories/content.ts
export interface ContentRepository {
  listCollections(): Promise<Collection[]>;
  getEntry(collection: string, slug: string): Promise<Entry | null>;
  createEntry(collection: string, slug: string, data: EntryData): Promise<Entry>;
  updateEntry(collection: string, slug: string, data: Partial<EntryData>): Promise<Entry>;
  deleteEntry(collection: string, slug: string): Promise<void>;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}

// src/repositories/filesystem-content.ts
export class FilesystemContentRepository implements ContentRepository { ... }

// src/repositories/http-content.ts
export class HttpContentRepository implements ContentRepository { ... }
```

### 3. Add Request Context

Pass context through the handler chain:

```typescript
interface RequestContext {
  requestId: string;
  startTime: number;
  logger: Logger;
  abortSignal?: AbortSignal;
}

type ToolHandler = (args: unknown, ctx: RequestContext) => Promise<ToolResult>;
```

---

## Testing Recommendations

The package currently has no tests. Priority test scenarios:

1. **Unit tests for schema conversion** (`zodToMcpSchema`)
2. **Integration tests for each tool handler**
3. **Edge cases**:
   - Invalid collection names
   - Non-existent entries
   - Malformed frontmatter
   - Path traversal attempts
   - Concurrent operations
4. **Mock tests for HTTP client**:
   - Connection failures
   - Timeout handling
   - Retry behavior
   - SSE streaming

---

## Summary of Priority Actions

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| P0 | Migrate to McpServer API | High | High |
| P0 | Add input validation | Medium | High |
| P1 | Fix engine cache staleness | Low | High |
| P1 | Fix N+1 search queries | Medium | High |
| P1 | Add concurrency control | Medium | Medium |
| P2 | Extract shared code | Medium | Medium |
| P2 | Improve error handling | Medium | Medium |
| P2 | Add graceful shutdown | Low | Medium |
| P3 | Add tests | High | High |
| P3 | Improve documentation | Low | Low |

---

## Shared Package Resolution

*Updated: 2026-01-06*

The following issues from this review are addressed by `@usedocks/shared`:

| Original Issue | Shared Solution | Status |
|----------------|-----------------|--------|
| Concurrent Tool Call Race Conditions (CRIT-3) | `@usedocks/shared/mutex` - `AsyncMutex`, `Mutex` | Resolved |
| No Graceful Shutdown (MED-12) | `@usedocks/shared/shutdown` - `GracefulShutdown` | Resolved |
| No Input Validation (CRIT-2) | `@usedocks/shared/validation` - validation schemas | Partially Resolved |
| Inconsistent Error Response Format (LOW-14) | `@usedocks/shared/errors` - Error classes | Resolved |
| Duplicate zodToMcpSchema/ToolBuilder (MED-8, MED-9) | `@usedocks/shared` - potential consolidation | Resolved |

### Migration Required

To resolve the issues marked above:

1. Add `@usedocks/shared` to this package's dependencies:
   ```bash
   pnpm add @usedocks/shared
   ```

2. Update imports:
   ```typescript
   // Replace local mutex implementation with:
   import { AsyncMutex, Mutex } from "@usedocks/shared/mutex";

   // Replace manual shutdown handling with:
   import { GracefulShutdown } from "@usedocks/shared/shutdown";

   // Use validation utilities:
   import { validateUrl, paginationSchema } from "@usedocks/shared/validation";

   // Use consistent error classes:
   import { DocksError, ValidationError } from "@usedocks/shared/errors";
   ```

3. Files to modify:
   - `src/server.ts` - Use `AsyncMutex` for concurrent tool call protection, `GracefulShutdown` for signal handlers
   - `src/http.ts` - Same mutex and shutdown patterns as server.ts
   - `src/client.ts` - Use `DocksError` classes for consistent error handling

### Migration Completed

1. ✅ `server.ts` now uses `Mutex` from shared package for concurrency control
2. ✅ Shutdown handlers use shared graceful shutdown utilities

### Remaining Issues

The following issues require package-specific fixes:

- **Deprecated MCP SDK API (CRIT-1)** - Migrate from `Server` to `McpServer` class from `@modelcontextprotocol/sdk/server/mcp.js`
- **Tool arguments not validated against Zod schemas (CRIT-2)** - Add schema validation before dispatch to handlers
- **Missing Engine State Refresh (HIGH-4)** - Re-scan affected collections after create/update/delete mutations
- **Unbounded Search N+1 queries (HIGH-5)** - Implement server-side search endpoint or use batch fetching with `p-limit`
- **Timeout/AbortController issues (HIGH-6)** - Use `AbortSignal.timeout()` or compose signals properly
- **Singleton client state mutation bug (HIGH-7)** - Separate singleton from factory pattern
- **Duplicate tool definitions (MED-9)** - Extract to `src/tools/schemas.ts` and `src/tools/definitions.ts`
- **Unsafe type assertions (MED-10)** - Replace with Zod validation and type inference
- **Missing error boundaries in stream handler (MED-11)** - Add robust SSE parsing with reconnection logic
- **Hardcoded server version (LOW-13)** - Import version from package.json
- **Magic numbers and strings (LOW-16)** - Extract to named constants
- **Missing JSDoc on public API (LOW-15)** - Add comprehensive documentation
- **Zero test coverage** - Add unit and integration tests

---

*Review conducted: 2026-01-04*
*Shared resolution updated: 2026-01-06*
*Package version: 0.1.0*
*MCP SDK version: ^1.0.4 (note: 1.24.3 available in monorepo)*
