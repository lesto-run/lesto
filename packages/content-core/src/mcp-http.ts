/**
 * MCP Server that wraps Studio HTTP API.
 *
 * This is the unified MCP implementation that works with both Claude Desktop
 * and Studio Chat Panel. All operations go through the Studio API, ensuring
 * consistent behavior and shared state.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  McpClient,
  StudioNotRunningError,
  type CollectionListResponse,
  type EntryInfo,
  type SchemaResponse,
  type VoiceProfileResponse,
  type AIStatusResponse,
} from "./mcp-client.js";

export interface McpHttpServerOptions {
  /** Studio API base URL (default: http://localhost:4400) */
  studioUrl?: string | undefined;
  /** Enable debug logging */
  debug?: boolean | undefined;
}

// JSON Schema type for MCP tool input schemas
interface McpInputSchema {
  type: "object";
  properties?: Record<
    string,
    {
      type?: string | string[];
      description?: string;
      items?: { type?: string; enum?: string[] };
      enum?: string[];
      [key: string]: unknown;
    }
  >;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

/**
 * MCP Tool Definitions using direct JSON Schema.
 * This removes the dependency on Zod for tool definitions.
 */
const CONTENT_TOOLS: Tool[] = [
  {
    name: "list_collections",
    description:
      "List all content collections in the Docks project, including their names and entry counts. Use this to discover what content is available.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } as McpInputSchema,
  },
  {
    name: "get_collection_schema",
    description:
      "Get the JSON Schema for a collection's frontmatter. Use this BEFORE creating or updating entries to understand what fields are required and their types.",
    inputSchema: {
      type: "object",
      properties: { collection: { type: "string", description: "The name of the collection" } },
      required: ["collection"],
      additionalProperties: false,
    } as McpInputSchema,
  },
  {
    name: "get_entry",
    description:
      "Get a single content entry by collection name and slug. Returns the entry's frontmatter data, content, and metadata.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "The name of the collection" },
        slug: { type: "string", description: "The slug/ID of the entry" },
      },
      required: ["collection", "slug"],
      additionalProperties: false,
    } as McpInputSchema,
  },
  {
    name: "search_content",
    description:
      "Search for content entries by text query. Searches in both frontmatter data and markdown content. Returns matching entries with context.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The text to search for" },
        collection: { type: "string", description: "Limit search to a specific collection" },
        limit: { type: "number", description: "Maximum number of results (default: 10)" },
      },
      required: ["query"],
      additionalProperties: false,
    } as McpInputSchema,
  },
  {
    name: "create_entry",
    description:
      "Create a new content entry in a collection. Validates against the collection schema and writes the file with proper frontmatter formatting.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "The name of the collection" },
        slug: {
          type: "string",
          description: "The slug/filename for the new entry (without extension)",
        },
        data: {
          type: "object",
          description: "The frontmatter data as a JSON object",
          additionalProperties: true,
        },
        content: { type: "string", description: "The markdown content body" },
      },
      required: ["collection", "slug", "data"],
      additionalProperties: false,
    } as McpInputSchema,
  },
  {
    name: "update_entry",
    description:
      "Update an existing content entry's frontmatter data or markdown content. Merges frontmatter changes with existing data.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "The name of the collection" },
        slug: { type: "string", description: "The slug/ID of the entry to update" },
        data: {
          type: "object",
          description: "Frontmatter data to merge/update",
          additionalProperties: true,
        },
        content: { type: "string", description: "New markdown content body (replaces existing)" },
      },
      required: ["collection", "slug"],
      additionalProperties: false,
    } as McpInputSchema,
  },
  {
    name: "delete_entry",
    description: "Delete a content entry from a collection. This permanently removes the file.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "The name of the collection" },
        slug: { type: "string", description: "The slug/ID of the entry to delete" },
      },
      required: ["collection", "slug"],
      additionalProperties: false,
    } as McpInputSchema,
  },
];

const VOICE_TOOLS: Tool[] = [
  {
    name: "get_voice_profile",
    description:
      "Get the voice profile system prompt for a collection. Use this to write content that matches the collection's writing style.",
    inputSchema: {
      type: "object",
      properties: { collection: { type: "string", description: "The name of the collection" } },
      required: ["collection"],
      additionalProperties: false,
    } as McpInputSchema,
  },
  {
    name: "get_voice_samples",
    description:
      "Get the voice samples used for a collection's voice profile. Returns sample metadata and content previews for analysis.",
    inputSchema: {
      type: "object",
      properties: { collection: { type: "string", description: "The name of the collection" } },
      required: ["collection"],
      additionalProperties: false,
    } as McpInputSchema,
  },
  {
    name: "get_voice_status",
    description:
      "Check if voice is configured for a collection and if there are enough entries for voice matching.",
    inputSchema: {
      type: "object",
      properties: { collection: { type: "string", description: "The name of the collection" } },
      required: ["collection"],
      additionalProperties: false,
    } as McpInputSchema,
  },
  {
    name: "voice_training_prepare",
    description:
      "Generate training data from a collection's content for voice fine-tuning. Returns instruction/output pairs in JSONL format.",
    inputSchema: {
      type: "object",
      properties: {
        collection: {
          type: "string",
          description: "The collection to generate training data from",
        },
        minWords: { type: "number", description: "Minimum words per chunk (default: 250)" },
        maxWords: { type: "number", description: "Maximum words per chunk (default: 650)" },
        instructionTypes: {
          type: "array",
          items: {
            type: "string",
            enum: ["write", "explain", "elaborate", "summarize", "continue", "rewrite"],
          },
          description: "Types of instructions to generate (default: ['write'])",
        },
        includeData: {
          type: "boolean",
          description:
            "Include the full JSONL data in response (default: false, returns stats only)",
        },
      },
      required: ["collection"],
      additionalProperties: false,
    } as McpInputSchema,
  },
];

const VOICE_AI_TOOLS: Tool[] = [
  {
    name: "voice_generate",
    description:
      "Generate content that matches a collection's voice/writing style. Uses AI with the voice profile as system prompt.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "The collection whose voice to use" },
        prompt: { type: "string", description: "The content generation prompt" },
        maxTokens: { type: "number", description: "Maximum tokens to generate (default: 2048)" },
      },
      required: ["collection", "prompt"],
      additionalProperties: false,
    } as McpInputSchema,
  },
  {
    name: "voice_check",
    description:
      "Check if content matches a collection's voice/writing style. Returns consistency analysis and suggestions.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "The collection whose voice to check against" },
        content: { type: "string", description: "The content to analyze for voice consistency" },
      },
      required: ["collection", "content"],
      additionalProperties: false,
    } as McpInputSchema,
  },
];

const AI_STATUS_TOOL: Tool = {
  name: "ai_status",
  description: "Check if AI features are configured and available in Studio.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false } as McpInputSchema,
};

const QUALITY_TOOLS: Tool[] = [
  {
    name: "quality_lint",
    description:
      "Check content for writing quality issues like long sentences, passive voice, and weasel words.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The content to lint" },
        collection: { type: "string", description: "Collection for context-specific rules" },
      },
      required: ["content"],
      additionalProperties: false,
    } as McpInputSchema,
  },
  {
    name: "quality_a11y",
    description:
      "Check content for accessibility issues: missing alt text, heading hierarchy, vague links, unlabeled code blocks.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The markdown content to check" },
        skipAltText: { type: "boolean", description: "Skip image alt text checks" },
        skipHeadings: { type: "boolean", description: "Skip heading hierarchy checks" },
        skipLinks: { type: "boolean", description: "Skip link text checks" },
        skipCodeBlocks: { type: "boolean", description: "Skip code block language checks" },
        skipEmbeds: { type: "boolean", description: "Skip embed/iframe checks" },
      },
      required: ["content"],
      additionalProperties: false,
    } as McpInputSchema,
  },
];

interface StudioCapabilities {
  content: boolean;
  voice: boolean;
  ai: boolean;
  git: boolean;
}

function createTools(capabilities?: StudioCapabilities): Tool[] {
  const tools: Tool[] = [...CONTENT_TOOLS];

  // Voice tools only if voice is configured
  if (!capabilities || capabilities.voice) {
    tools.push(...VOICE_TOOLS);
    // AI-powered voice tools require both voice and AI
    if (!capabilities || capabilities.ai) {
      tools.push(...VOICE_AI_TOOLS);
    }
  }

  // AI status tool only if AI is configured
  if (!capabilities || capabilities.ai) {
    tools.push(AI_STATUS_TOOL);
  }

  // Quality tools are always available
  tools.push(...QUALITY_TOOLS);

  return tools;
}

// Tool handlers that call Studio API via HTTP client

async function handleListCollections(client: McpClient): Promise<string> {
  const response = await client.get<CollectionListResponse>("/api/collections");

  if (!response.ok) {
    return `Error: ${response.error}`;
  }

  if (!response.data?.collections.length) {
    return "No collections found. Check your docks.config.ts.";
  }

  const result = response.data.collections.map((col) => ({
    name: col.name,
    entryCount: col.entries.length,
    entries: col.entries.map((e) => ({
      slug: e.slug,
    })),
  }));

  return JSON.stringify(result, null, 2);
}

async function handleGetSchema(client: McpClient, args: { collection: string }): Promise<string> {
  const response = await client.get<SchemaResponse>(
    `/api/collections/${encodeURIComponent(args.collection)}/schema`,
  );

  if (!response.ok) {
    return `Error: ${response.error}`;
  }

  return JSON.stringify(response.data, null, 2);
}

async function handleGetEntry(
  client: McpClient,
  args: { collection: string; slug: string },
): Promise<string> {
  const response = await client.get<EntryInfo>(
    `/api/collections/${encodeURIComponent(args.collection)}/${encodeURIComponent(args.slug)}`,
  );

  if (!response.ok) {
    return `Entry not found: ${args.collection}/${args.slug}`;
  }

  return JSON.stringify(response.data, null, 2);
}

interface HttpSearchResult {
  collection: string;
  slug: string;
  matches: string[];
}

function extractHttpContentMatch(content: string, query: string): string | null {
  const lowerContent = content.toLowerCase();
  if (!lowerContent.includes(query)) return null;
  const index = lowerContent.indexOf(query);
  const start = Math.max(0, index - 50);
  const end = Math.min(content.length, index + query.length + 50);
  return `Content: ...${content.slice(start, end)}...`;
}

function searchEntryData(entryData: EntryInfo, query: string, originalQuery: string): string[] {
  const matches: string[] = [];
  const content = entryData.content ?? "";

  const contentMatch = extractHttpContentMatch(content, query);
  if (contentMatch) {
    matches.push(contentMatch);
  }

  if (!matches.length) {
    const dataStr = JSON.stringify(entryData.data).toLowerCase();
    if (dataStr.includes(query)) {
      matches.push(`Data contains: "${originalQuery}"`);
    }
  }

  return matches;
}

/** Search a single entry and return result if matches found */
async function searchSingleEntry(
  client: McpClient,
  collectionName: string,
  slug: string,
  query: string,
  originalQuery: string,
): Promise<HttpSearchResult | null> {
  const entryResponse = await client.get<EntryInfo>(
    `/api/collections/${encodeURIComponent(collectionName)}/${encodeURIComponent(slug)}`,
  );

  if (!entryResponse.ok) return null;

  const matches = searchEntryData(entryResponse.data!, query, originalQuery);
  if (matches.length === 0) return null;

  return { collection: collectionName, slug, matches };
}

async function handleSearchContent(
  client: McpClient,
  args: { query: string; collection?: string; limit?: number },
): Promise<string> {
  const collectionsResponse = await client.get<CollectionListResponse>("/api/collections");
  if (!collectionsResponse.ok) {
    return `Error: ${collectionsResponse.error}`;
  }

  const query = args.query.toLowerCase();
  const limit = args.limit ?? 10;
  const results: HttpSearchResult[] = [];

  const collections = args.collection
    ? collectionsResponse.data!.collections.filter((c) => c.name === args.collection)
    : collectionsResponse.data!.collections;

  for (const col of collections) {
    for (const entry of col.entries) {
      if (results.length >= limit) break;
      const result = await searchSingleEntry(client, col.name, entry.slug, query, args.query);
      if (result) results.push(result);
    }
    if (results.length >= limit) break;
  }

  return results.length === 0
    ? `No results found for query: "${args.query}"`
    : JSON.stringify(results, null, 2);
}

async function handleCreateEntry(
  client: McpClient,
  args: {
    collection: string;
    slug: string;
    data: Record<string, unknown>;
    content?: string;
  },
): Promise<string> {
  const response = await client.post<{ success: boolean; filePath?: string }>("/api/entries", {
    collection: args.collection,
    slug: args.slug,
    data: args.data,
    content: args.content ?? "",
  });

  if (!response.ok) {
    return `Error: ${response.error}`;
  }

  return `Successfully created entry at ${response.data?.filePath ?? `${args.collection}/${args.slug}`}`;
}

async function handleUpdateEntry(
  client: McpClient,
  args: {
    collection: string;
    slug: string;
    data?: Record<string, unknown>;
    content?: string;
  },
): Promise<string> {
  const response = await client.put<{ success: boolean }>(
    `/api/collections/${encodeURIComponent(args.collection)}/${encodeURIComponent(args.slug)}`,
    {
      data: args.data,
      content: args.content,
    },
  );

  if (!response.ok) {
    return `Error: ${response.error}`;
  }

  return `Successfully updated entry: ${args.collection}/${args.slug}`;
}

async function handleDeleteEntry(
  client: McpClient,
  args: { collection: string; slug: string },
): Promise<string> {
  const response = await client.delete<{ success: boolean }>(
    `/api/collections/${encodeURIComponent(args.collection)}/${encodeURIComponent(args.slug)}`,
  );

  if (!response.ok) {
    return `Error: ${response.error}`;
  }

  return `Successfully deleted entry: ${args.collection}/${args.slug}`;
}

async function handleGetVoiceProfile(
  client: McpClient,
  args: { collection: string },
): Promise<string> {
  const response = await client.get<VoiceProfileResponse>(
    `/api/voice/${encodeURIComponent(args.collection)}`,
  );

  if (!response.ok) {
    return `Error: ${response.error}`;
  }

  return JSON.stringify(response.data, null, 2);
}

interface VoiceSamplesResponse {
  collection: string;
  sampleCount: number;
  samples: Array<{
    entryId: string;
    title?: string;
    author?: string;
    isExemplary: boolean;
    contentLength: number;
    preview?: string;
  }>;
}

async function handleGetVoiceSamples(
  client: McpClient,
  args: { collection: string },
): Promise<string> {
  const response = await client.get<VoiceSamplesResponse>(
    `/api/voice/${encodeURIComponent(args.collection)}/samples`,
  );

  if (!response.ok) {
    return `Error: ${response.error}`;
  }

  return JSON.stringify(response.data, null, 2);
}

interface VoiceStatusResponse {
  configured: boolean;
  entryCount?: number;
  minEntries?: number;
  reason?: string | null;
}

async function handleGetVoiceStatus(
  client: McpClient,
  args: { collection: string },
): Promise<string> {
  const response = await client.get<VoiceStatusResponse>(
    `/api/voice/${encodeURIComponent(args.collection)}/status`,
  );

  if (!response.ok) {
    return `Error: ${response.error}`;
  }

  return JSON.stringify(response.data, null, 2);
}

interface AIGenerateResponse {
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

async function handleVoiceGenerate(
  client: McpClient,
  args: { collection: string; prompt: string; maxTokens?: number },
): Promise<string> {
  // Call AI endpoint with collection to auto-include voice profile
  const response = await client.post<AIGenerateResponse>("/api/ai", {
    collection: args.collection,
    prompt: args.prompt,
    maxTokens: args.maxTokens ?? 2048,
    stream: false,
  });

  if (!response.ok) {
    return `Error: ${response.error}`;
  }

  return response.data?.text ?? "";
}

async function handleVoiceCheck(
  client: McpClient,
  args: { collection: string; content: string },
): Promise<string> {
  // Use AI to analyze voice consistency
  const prompt = `Analyze the following content for voice consistency with the collection's writing style.

Content to analyze:
---
${args.content}
---

Provide:
1. A consistency score (1-10)
2. Key observations about tone, vocabulary, and style
3. Specific suggestions for improvement
4. Examples of phrases that match or don't match the voice

Format your response as JSON with fields: score, observations, suggestions, examples`;

  const response = await client.post<AIGenerateResponse>("/api/ai", {
    collection: args.collection,
    prompt,
    maxTokens: 1024,
    stream: false,
  });

  if (!response.ok) {
    return `Error: ${response.error}`;
  }

  return response.data?.text ?? "";
}

interface TrainingStatsResponse {
  collection: string;
  stats: {
    totalPairs: number;
    totalWords: number;
    averageWords: number;
    exemplaryPairs: number;
    byCollection: Record<string, number>;
    byAuthor: Record<string, number>;
  };
  data?: string;
}

async function handleVoiceTrainingPrepare(
  client: McpClient,
  args: {
    collection: string;
    minWords?: number;
    maxWords?: number;
    instructionTypes?: string[];
    includeData?: boolean;
  },
): Promise<string> {
  const response = await client.post<TrainingStatsResponse>(
    `/api/voice/${encodeURIComponent(args.collection)}/training`,
    {
      minWords: args.minWords,
      maxWords: args.maxWords,
      instructionTypes: args.instructionTypes,
      includeData: args.includeData,
    },
  );

  if (!response.ok) {
    return `Error: ${response.error}`;
  }

  return JSON.stringify(response.data, null, 2);
}

async function handleAIStatus(client: McpClient): Promise<string> {
  const response = await client.get<AIStatusResponse>("/api/ai/status");

  if (!response.ok) {
    return JSON.stringify({ configured: false, error: response.error }, null, 2);
  }

  return JSON.stringify(response.data, null, 2);
}

interface LintResponse {
  valid: boolean;
  errors: Array<{
    severity: string;
    message: string;
    rule: string;
    position?: { line: number; column: number };
  }>;
  warnings: Array<{
    severity: string;
    message: string;
    rule: string;
    position?: { line: number; column: number };
  }>;
  stats: {
    errorCount: number;
    warningCount: number;
  };
}

async function handleQualityLint(
  client: McpClient,
  args: { content: string; collection?: string },
): Promise<string> {
  const response = await client.post<LintResponse>("/api/quality/lint", {
    content: args.content,
    collection: args.collection,
  });

  if (!response.ok) {
    return `Error: ${response.error}`;
  }

  return JSON.stringify(response.data, null, 2);
}

interface A11yResponse {
  diagnostics: Array<{
    severity: string;
    message: string;
    rule: string;
    line: number;
    column: number;
    help?: string;
  }>;
  errorCount: number;
  warningCount: number;
}

async function handleQualityA11y(
  client: McpClient,
  args: {
    content: string;
    skipAltText?: boolean;
    skipHeadings?: boolean;
    skipLinks?: boolean;
    skipCodeBlocks?: boolean;
    skipEmbeds?: boolean;
  },
): Promise<string> {
  const response = await client.post<A11yResponse>("/api/quality/a11y", {
    content: args.content,
    options: {
      skipAltText: args.skipAltText,
      skipHeadings: args.skipHeadings,
      skipLinks: args.skipLinks,
      skipCodeBlocks: args.skipCodeBlocks,
      skipEmbeds: args.skipEmbeds,
    },
  });

  if (!response.ok) {
    return `Error: ${response.error}`;
  }

  return JSON.stringify(response.data, null, 2);
}

// Handler registry for tool dispatch
type HttpToolHandler = (client: McpClient, args: Record<string, unknown>) => Promise<string>;

const HTTP_TOOL_HANDLERS: Record<string, HttpToolHandler> = {
  list_collections: (client) => handleListCollections(client),
  get_collection_schema: (client, args) => handleGetSchema(client, args as { collection: string }),
  get_entry: (client, args) => handleGetEntry(client, args as { collection: string; slug: string }),
  search_content: (client, args) =>
    handleSearchContent(client, args as { query: string; collection?: string; limit?: number }),
  create_entry: (client, args) =>
    handleCreateEntry(
      client,
      args as { collection: string; slug: string; data: Record<string, unknown>; content?: string },
    ),
  update_entry: (client, args) =>
    handleUpdateEntry(
      client,
      args as {
        collection: string;
        slug: string;
        data?: Record<string, unknown>;
        content?: string;
      },
    ),
  delete_entry: (client, args) =>
    handleDeleteEntry(client, args as { collection: string; slug: string }),
  get_voice_profile: (client, args) =>
    handleGetVoiceProfile(client, args as { collection: string }),
  get_voice_samples: (client, args) =>
    handleGetVoiceSamples(client, args as { collection: string }),
  get_voice_status: (client, args) => handleGetVoiceStatus(client, args as { collection: string }),
  voice_generate: (client, args) =>
    handleVoiceGenerate(client, args as { collection: string; prompt: string; maxTokens?: number }),
  voice_check: (client, args) =>
    handleVoiceCheck(client, args as { collection: string; content: string }),
  voice_training_prepare: (client, args) =>
    handleVoiceTrainingPrepare(
      client,
      args as {
        collection: string;
        minWords?: number;
        maxWords?: number;
        instructionTypes?: string[];
        includeData?: boolean;
      },
    ),
  ai_status: (client) => handleAIStatus(client),
  quality_lint: (client, args) =>
    handleQualityLint(client, args as { content: string; collection?: string }),
  quality_a11y: (client, args) =>
    handleQualityA11y(
      client,
      args as {
        content: string;
        skipAltText?: boolean;
        skipHeadings?: boolean;
        skipLinks?: boolean;
        skipCodeBlocks?: boolean;
        skipEmbeds?: boolean;
      },
    ),
};

// Every tool this server exposes, indexed by name, so we can validate incoming
// arguments against the same JSON Schema we advertise to the client.
export const ALL_TOOLS: Record<string, Tool> = Object.fromEntries(
  [...CONTENT_TOOLS, ...VOICE_TOOLS, ...VOICE_AI_TOOLS, AI_STATUS_TOOL, ...QUALITY_TOOLS].map(
    (tool) => [tool.name, tool],
  ),
);

/**
 * Validate request arguments against a tool's declared input schema.
 *
 * WHY: handlers previously cast `args` straight to their expected shape, so a
 * missing required field or a wrong-typed value (e.g. `query` as a number)
 * surfaced only as an opaque downstream TypeError, or sent garbage to the
 * Studio API. We check required presence and primitive types up front and
 * return a clear message the model can act on. Returns null when args are valid.
 */
export function validateToolArgs(tool: Tool, args: Record<string, unknown>): string | null {
  const schema = tool.inputSchema as McpInputSchema;
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];

  for (const field of required) {
    if (args[field] === undefined || args[field] === null) {
      return `Missing required argument "${field}" for tool "${tool.name}".`;
    }
  }

  for (const [field, value] of Object.entries(args)) {
    if (value === undefined || value === null) {
      continue;
    }

    const declaredType = properties[field]?.type;
    const expected = Array.isArray(declaredType)
      ? declaredType
      : declaredType
        ? [declaredType]
        : [];
    if (expected.length === 0) {
      continue;
    }

    const actual = Array.isArray(value) ? "array" : typeof value;
    if (!expected.includes(actual)) {
      return `Argument "${field}" for tool "${tool.name}" must be of type ${expected.join(" | ")}, received ${actual}.`;
    }
  }

  return null;
}

async function handleToolCall(
  client: McpClient,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const handler = HTTP_TOOL_HANDLERS[name];
  if (!handler) {
    return `Unknown tool: ${name}`;
  }

  const tool = ALL_TOOLS[name];
  if (tool) {
    const validationError = validateToolArgs(tool, args);
    if (validationError) {
      return `Error: ${validationError}`;
    }
  }

  return handler(client, args);
}

export async function createMcpHttpServer(options: McpHttpServerOptions = {}): Promise<Server> {
  const client = new McpClient({
    baseUrl: options.studioUrl,
    debug: options.debug,
  });

  // Check if Studio is running and get capabilities
  let capabilities: StudioCapabilities | undefined;
  const studioRunning = await client.isStudioRunning();

  if (!studioRunning) {
    console.error(
      "[MCP] Warning: Studio API is not running. Tools may fail. Start with: docks studio",
    );
  } else {
    // Fetch capabilities from Studio
    const capResponse = await client.get<StudioCapabilities>("/api/capabilities");
    if (capResponse.ok && capResponse.data) {
      capabilities = capResponse.data;
    }
  }

  const server = new Server(
    {
      name: "docks",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Re-fetch capabilities on each request to handle hot-reload
    let currentCapabilities = capabilities;
    if (studioRunning) {
      const capResponse = await client.get<StudioCapabilities>("/api/capabilities");
      if (capResponse.ok && capResponse.data) {
        currentCapabilities = capResponse.data;
      }
    }
    const tools = createTools(currentCapabilities);
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await handleToolCall(client, name, args ?? {});

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      let errorMessage: string;

      if (error instanceof StudioNotRunningError) {
        errorMessage = error.message;
      } else {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      return {
        content: [
          {
            type: "text",
            text: `Error executing tool "${name}": ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

export async function startMcpHttpServer(options: McpHttpServerOptions = {}): Promise<void> {
  const server = await createMcpHttpServer(options);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await server.close();
    process.exit(0);
  });
}
