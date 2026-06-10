/**
 * MCP Server that wraps Studio HTTP API.
 *
 * This is the unified MCP implementation that works with both Claude Desktop
 * and Studio Chat Panel. All operations go through the Studio API, ensuring
 * consistent behavior and shared state.
 */

import { z } from "zod";
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
} from "./client.js";
import { ToolBuilder, DEFAULT_SEARCH_LIMIT } from "./tools.js";

export interface McpHttpServerOptions {
  /** Studio API base URL (default: http://localhost:4400) */
  studioUrl?: string | undefined;
  /** Enable debug logging */
  debug?: boolean | undefined;
}

// Tool definitions using ToolBuilder
const CONTENT_TOOLS: Tool[] = [
  ToolBuilder.create("list_collections")
    .description(
      "List all content collections in the Docks project, including their names and entry counts. Use this to discover what content is available.",
    )
    .noParams()
    .build(),
  ToolBuilder.create("get_collection_schema")
    .description(
      "Get the JSON Schema for a collection's frontmatter. Use this BEFORE creating or updating entries to understand what fields are required and their types.",
    )
    .params(
      z.object({
        collection: z.string().describe("The name of the collection"),
      }),
    )
    .build(),
  ToolBuilder.create("get_entry")
    .description(
      "Get a single content entry by collection name and slug. Returns the entry's frontmatter data, content, and metadata.",
    )
    .params(
      z.object({
        collection: z.string().describe("The name of the collection"),
        slug: z.string().describe("The slug/ID of the entry"),
      }),
    )
    .build(),
  ToolBuilder.create("search_content")
    .description(
      "Search for content entries by text query. Searches in both frontmatter data and markdown content. Returns matching entries with context.",
    )
    .params(
      z.object({
        query: z.string().describe("The text to search for"),
        collection: z.string().optional().describe("Limit search to a specific collection"),
        limit: z.number().optional().describe("Maximum number of results (default: 10)"),
      }),
    )
    .build(),
  ToolBuilder.create("create_entry")
    .description(
      "Create a new content entry in a collection. Validates against the collection schema and writes the file with proper frontmatter formatting.",
    )
    .params(
      z.object({
        collection: z.string().describe("The name of the collection"),
        slug: z.string().describe("The slug/filename for the new entry (without extension)"),
        data: z.record(z.string(), z.unknown()).describe("The frontmatter data as a JSON object"),
        content: z.string().optional().describe("The markdown content body"),
      }),
    )
    .build(),
  ToolBuilder.create("update_entry")
    .description(
      "Update an existing content entry's frontmatter data or markdown content. Merges frontmatter changes with existing data.",
    )
    .params(
      z.object({
        collection: z.string().describe("The name of the collection"),
        slug: z.string().describe("The slug/ID of the entry to update"),
        data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Frontmatter data to merge/update"),
        content: z.string().optional().describe("New markdown content body (replaces existing)"),
      }),
    )
    .build(),
  ToolBuilder.create("delete_entry")
    .description("Delete a content entry from a collection. This permanently removes the file.")
    .params(
      z.object({
        collection: z.string().describe("The name of the collection"),
        slug: z.string().describe("The slug/ID of the entry to delete"),
      }),
    )
    .build(),
];

const VOICE_TOOLS: Tool[] = [
  ToolBuilder.create("get_voice_profile")
    .description(
      "Get the voice profile system prompt for a collection. Use this to write content that matches the collection's writing style.",
    )
    .params(
      z.object({
        collection: z.string().describe("The name of the collection"),
      }),
    )
    .build(),
  ToolBuilder.create("get_voice_samples")
    .description(
      "Get the voice samples used for a collection's voice profile. Returns sample metadata and content previews for analysis.",
    )
    .params(
      z.object({
        collection: z.string().describe("The name of the collection"),
      }),
    )
    .build(),
  ToolBuilder.create("get_voice_status")
    .description(
      "Check if voice is configured for a collection and if there are enough entries for voice matching.",
    )
    .params(
      z.object({
        collection: z.string().describe("The name of the collection"),
      }),
    )
    .build(),
  ToolBuilder.create("voice_training_prepare")
    .description(
      "Generate training data from a collection's content for voice fine-tuning. Returns instruction/output pairs in JSONL format.",
    )
    .params(
      z.object({
        collection: z.string().describe("The collection to generate training data from"),
        minWords: z.number().optional().describe("Minimum words per chunk (default: 250)"),
        maxWords: z.number().optional().describe("Maximum words per chunk (default: 650)"),
        instructionTypes: z
          .array(z.enum(["write", "explain", "elaborate", "summarize", "continue", "rewrite"]))
          .optional()
          .describe("Types of instructions to generate (default: ['write'])"),
        includeData: z
          .boolean()
          .optional()
          .describe("Include the full JSONL data in response (default: false, returns stats only)"),
      }),
    )
    .build(),
];

const VOICE_AI_TOOLS: Tool[] = [
  ToolBuilder.create("voice_generate")
    .description(
      "Generate content that matches a collection's voice/writing style. Uses AI with the voice profile as system prompt.",
    )
    .params(
      z.object({
        collection: z.string().describe("The collection whose voice to use"),
        prompt: z.string().describe("The content generation prompt"),
        maxTokens: z.number().optional().describe("Maximum tokens to generate (default: 2048)"),
      }),
    )
    .build(),
  ToolBuilder.create("voice_check")
    .description(
      "Check if content matches a collection's voice/writing style. Returns consistency analysis and suggestions.",
    )
    .params(
      z.object({
        collection: z.string().describe("The collection whose voice to check against"),
        content: z.string().describe("The content to analyze for voice consistency"),
      }),
    )
    .build(),
];

const AI_STATUS_TOOL: Tool = ToolBuilder.create("ai_status")
  .description("Check if AI features are configured and available in Studio.")
  .noParams()
  .build();

const QUALITY_TOOLS: Tool[] = [
  ToolBuilder.create("quality_lint")
    .description(
      "Check content for writing quality issues like long sentences, passive voice, and weasel words.",
    )
    .params(
      z.object({
        content: z.string().describe("The content to lint"),
        collection: z.string().optional().describe("Collection for context-specific rules"),
      }),
    )
    .build(),
  ToolBuilder.create("quality_a11y")
    .description(
      "Check content for accessibility issues: missing alt text, heading hierarchy, vague links, unlabeled code blocks.",
    )
    .params(
      z.object({
        content: z.string().describe("The markdown content to check"),
        skipAltText: z.boolean().optional().describe("Skip image alt text checks"),
        skipHeadings: z.boolean().optional().describe("Skip heading hierarchy checks"),
        skipLinks: z.boolean().optional().describe("Skip link text checks"),
        skipCodeBlocks: z.boolean().optional().describe("Skip code block language checks"),
        skipEmbeds: z.boolean().optional().describe("Skip embed/iframe checks"),
      }),
    )
    .build(),
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

async function handleSearchContent(
  client: McpClient,
  args: { query: string; collection?: string; limit?: number },
): Promise<string> {
  const collectionsResponse = await client.get<CollectionListResponse>("/api/collections");

  if (!collectionsResponse.ok) {
    return `Error: ${collectionsResponse.error}`;
  }

  const query = args.query.toLowerCase();
  const limit = args.limit ?? DEFAULT_SEARCH_LIMIT;
  const results: HttpSearchResult[] = [];

  const collections = args.collection
    ? collectionsResponse.data!.collections.filter((c) => c.name === args.collection)
    : collectionsResponse.data!.collections;

  outer: for (const col of collections) {
    for (const entry of col.entries) {
      const entryResponse = await client.get<EntryInfo>(
        `/api/collections/${encodeURIComponent(col.name)}/${encodeURIComponent(entry.slug)}`,
      );

      if (!entryResponse.ok) continue;

      const matches = searchEntryData(entryResponse.data!, query, args.query);

      if (matches.length > 0) {
        results.push({
          collection: col.name,
          slug: entry.slug,
          matches,
        });
        if (results.length >= limit) break outer;
      }
    }
  }

  if (results.length === 0) {
    return `No results found for query: "${args.query}"`;
  }

  return JSON.stringify(results, null, 2);
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

// JSON Schema shape for an MCP tool's advertised input, as produced by
// ToolBuilder (which serializes a Zod object via zod-to-json-schema).
interface McpInputSchema {
  type: "object";
  properties?: Record<
    string,
    {
      type?: string | string[];
      [key: string]: unknown;
    }
  >;
  required?: string[];
  [key: string]: unknown;
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
      args as {
        collection: string;
        slug: string;
        data: Record<string, unknown>;
        content?: string;
      },
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
