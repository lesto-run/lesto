import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolveConfig, type ResolvedConfig } from "./config";
import { createEngine } from "./engine";
import { stringify } from "@keel/content-umbra";
import { schemaToJsonSchema } from "./schema-introspector";
import type { Engine, RuntimeEntry } from "./types";

export interface McpServerOptions {
  cwd?: string;
}

/**
 * Check whether a string contains any ASCII control characters (U+0000–U+001F).
 * Avoids embedding control characters directly in a regular expression.
 */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code !== undefined && code <= 0x1f) {
      return true;
    }
  }
  return false;
}

// JSON Schema type for MCP tool input schemas
interface McpInputSchema {
  type: "object";
  properties?: Record<string, {
    type?: string;
    description?: string;
    [key: string]: unknown;
  }>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

/**
 * MCP Tool Definitions using direct JSON Schema.
 *
 * Each tool is defined with its name, description, and input schema.
 * This removes the dependency on Zod for tool definitions.
 */
const TOOLS: Tool[] = [
  {
    name: "list_collections",
    description: "List all content collections in the Docks project, including their names and entry counts. Use this to discover what content is available.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as McpInputSchema,
  },
  {
    name: "get_collection_schema",
    description: "Get the JSON Schema for a collection's frontmatter. Use this BEFORE creating or updating entries to understand what fields are required and their types.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "The name of the collection" },
      },
      required: ["collection"],
      additionalProperties: false,
    } as McpInputSchema,
  },
  {
    name: "get_entry",
    description: "Get a single content entry by collection name and slug. Returns the entry's frontmatter data, content, and metadata.",
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
    description: "Search for content entries by text query. Searches in both frontmatter data and markdown content. Returns matching entries with context.",
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
    description: "Create a new content entry in a collection. Validates against the collection schema and writes the file with proper frontmatter formatting.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "The name of the collection" },
        slug: { type: "string", description: "The slug/filename for the new entry (without extension)" },
        data: { type: "object", description: "The frontmatter data as a JSON object", additionalProperties: true },
        content: { type: "string", description: "The markdown content body" },
      },
      required: ["collection", "slug", "data"],
      additionalProperties: false,
    } as McpInputSchema,
  },
  {
    name: "update_entry",
    description: "Update an existing content entry's frontmatter data or markdown content. Merges frontmatter changes with existing data.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "The name of the collection" },
        slug: { type: "string", description: "The slug/ID of the entry to update" },
        data: { type: "object", description: "Frontmatter data to merge/update", additionalProperties: true },
        content: { type: "string", description: "New markdown content body (replaces existing)" },
      },
      required: ["collection", "slug"],
      additionalProperties: false,
    } as McpInputSchema,
  },
];

function handleListCollections(engine: Engine): string {
  const collections = engine.getCollections();

  if (collections.length === 0) {
    return "No collections found. Run scan() first or check your docks.config.ts.";
  }

  const result = collections.map((col) => ({
    name: col.name,
    entryCount: col.entries.length,
    entries: col.entries.map((entry) => ({
      id: entry.id,
      slug: entry["slug"] as string,
    })),
  }));

  return JSON.stringify(result, null, 2);
}

function handleGetSchema(
  config: ResolvedConfig,
  args: { collection: string },
): string {
  const collectionConfig = config.collections.find((c) => c.name === args.collection);

  if (!collectionConfig) {
    const available = config.collections.map((c) => c.name).join(", ");
    return `Error: Collection "${args.collection}" not found. Available collections: ${available}`;
  }

  try {
    const jsonSchema = schemaToJsonSchema(collectionConfig.schema);
    return JSON.stringify(jsonSchema, null, 2);
  } catch (error) {
    return `Error converting schema: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function handleGetEntry(
  engine: Engine,
  args: { collection: string; slug: string },
): string {
  const entry = engine.getEntry(args.collection, args.slug);

  if (!entry) {
    return `Entry not found: ${args.collection}/${args.slug}`;
  }

  return JSON.stringify(entry, null, 2);
}

interface SearchResult {
  collection: string;
  id: string;
  slug: string;
  matches: string[];
}

function extractContentMatch(content: string, query: string): string | null {
  const lowerContent = content.toLowerCase();
  if (!lowerContent.includes(query)) return null;
  const index = lowerContent.indexOf(query);
  const start = Math.max(0, index - 50);
  const end = Math.min(content.length, index + query.length + 50);
  return `Content: ...${content.slice(start, end)}...`;
}

function searchEntry(
  entry: RuntimeEntry,
  query: string,
): SearchResult | null {
  const matches: string[] = [];
  const content = (entry["content"] as string) || "";
  const slug = entry["slug"] as string;

  const contentMatch = extractContentMatch(content, query);
  if (contentMatch) {
    matches.push(contentMatch);
  }

  if (!matches.length) {
    const entryStr = JSON.stringify(entry).toLowerCase();
    if (entryStr.includes(query)) {
      matches.push(`Entry contains: "${query}"`);
    }
  }

  if (matches.length === 0) return null;
  return {
    collection: entry.collection,
    id: entry.id,
    slug,
    matches,
  };
}

function handleSearchContent(
  engine: Engine,
  args: { query: string; collection?: string; limit?: number },
): string {
  const query = args.query.toLowerCase();
  const limit = args.limit ?? 10;
  const results: SearchResult[] = [];

  const collections = args.collection
    ? engine.getCollections().filter((c) => c.name === args.collection)
    : engine.getCollections();

  outer: for (const col of collections) {
    for (const entry of col.entries) {
      const result = searchEntry(entry, query);
      if (result) {
        results.push(result);
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
  engine: Engine,
  config: ResolvedConfig,
  args: { collection: string; slug: string; data: Record<string, unknown>; content?: string },
): Promise<string> {
  // Validate slug: prevent path traversal by rejecting dangerous patterns
  const slug = args.slug;
  if (
    !slug ||
    slug.includes("..") ||
    slug.includes("/") ||
    slug.includes("\\") ||
    slug.startsWith(".") ||
    /[<>:"|?*]/.test(slug) ||
    hasControlCharacter(slug)
  ) {
    return `Error: Invalid slug "${slug}". Slugs must be simple filenames without path separators or special characters.`;
  }

  const existing = engine.getEntry(args.collection, slug);
  if (existing) {
    return `Error: Entry already exists at ${args.collection}/${slug}`;
  }

  const collectionConfig = config.collections.find((c) => c.name === args.collection);

  if (!collectionConfig) {
    const available = config.collections.map((c) => c.name).join(", ");
    return `Error: Collection "${args.collection}" not found. Available collections: ${available}`;
  }

  const collectionDir = path.isAbsolute(collectionConfig.directory)
    ? collectionConfig.directory
    : path.join(config.cwd, collectionConfig.directory);

  const filePath = path.join(collectionDir, `${slug}.md`);

  // Double-check: ensure resolved path is within collection directory
  const resolvedPath = path.resolve(filePath);
  const resolvedDir = path.resolve(collectionDir);
  if (!resolvedPath.startsWith(resolvedDir + path.sep)) {
    return `Error: Invalid file path. Path must be within collection directory.`;
  }

  const fileContent = stringify(args.data, args.content ?? "", { language: "yaml" });

  try {
    await writeFile(filePath, fileContent, "utf-8");
    return `Successfully created entry at ${filePath}`;
  } catch (error) {
    return `Error writing file: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function handleUpdateEntry(
  engine: Engine,
  config: ResolvedConfig,
  args: {
    collection: string;
    slug: string;
    data?: Record<string, unknown>;
    content?: string;
  },
): Promise<string> {
  const entry = engine.getEntry(args.collection, args.slug);

  if (!entry) {
    return `Error: Entry not found at ${args.collection}/${args.slug}`;
  }

  const collectionConfig = config.collections.find((c) => c.name === args.collection);
  if (!collectionConfig) {
    return `Error: Collection "${args.collection}" not found in config`;
  }

  const collectionDir = path.isAbsolute(collectionConfig.directory)
    ? collectionConfig.directory
    : path.join(config.cwd, collectionConfig.directory);

  const filePath = path.join(collectionDir, entry.file.path);

  // Validate: ensure resolved path is within collection directory (defense in depth)
  const resolvedPath = path.resolve(filePath);
  const resolvedDir = path.resolve(collectionDir);
  if (!resolvedPath.startsWith(resolvedDir + path.sep)) {
    return `Error: Invalid file path. Path must be within collection directory.`;
  }

  // Extract schema data from entry (excluding reserved fields)
  const entryRecord = entry as Record<string, unknown>;
  const existingData: Record<string, unknown> = {};
  for (const key of Object.keys(entryRecord)) {
    if (!key.startsWith("_") && key !== "content" && key !== "slug" && key !== "rendered") {
      existingData[key] = entryRecord[key];
    }
  }

  const updatedData = args.data ? { ...existingData, ...args.data } : existingData;
  const existingContent = entryRecord["content"] as string | undefined;
  const updatedContent = args.content !== undefined ? args.content : (existingContent ?? "");
  const fileContent = stringify(updatedData, updatedContent, { language: "yaml" });

  try {
    await writeFile(filePath, fileContent, "utf-8");
    return `Successfully updated entry at ${filePath}`;
  } catch (error) {
    return `Error writing file: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// Handler registry for tool dispatch
type ToolHandler = (
  engine: Engine,
  config: ResolvedConfig,
  args: Record<string, unknown>
) => Promise<string> | string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  list_collections: (engine) => handleListCollections(engine),
  get_collection_schema: (_, config, args) => handleGetSchema(config, args as { collection: string }),
  get_entry: (engine, _, args) => handleGetEntry(engine, args as { collection: string; slug: string }),
  search_content: (engine, _, args) => handleSearchContent(engine, args as { query: string; collection?: string; limit?: number }),
  create_entry: (engine, config, args) => handleCreateEntry(engine, config, args as { collection: string; slug: string; data: Record<string, unknown>; content?: string }),
  update_entry: (engine, config, args) => handleUpdateEntry(engine, config, args as { collection: string; slug: string; data?: Record<string, unknown>; content?: string }),
};

async function handleToolCall(
  engine: Engine,
  config: ResolvedConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const handler = TOOL_HANDLERS[name];
  return handler ? handler(engine, config, args) : `Unknown tool: ${name}`;
}

export async function createMcpServer(options: McpServerOptions = {}): Promise<Server> {
  const cwd = options.cwd ?? process.cwd();

  const config = await resolveConfig(cwd);

  const engine = createEngine({
    cwd,
    collections: config.collections,
    mode: config.mode,
  });

  await engine.scan();

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
    const tools = TOOLS;
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await handleToolCall(engine, config, name, args ?? {});

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
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

export async function startMcpServer(options: McpServerOptions = {}): Promise<void> {
  const server = await createMcpServer(options);
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
