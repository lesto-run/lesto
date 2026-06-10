import { z } from "zod";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  resolveConfig,
  createEngine,
  type ResolvedConfig,
  type Engine,
  type RuntimeEntry,
} from "@keel/content-core/build";
import { stringify } from "@keel/content-umbra";
import { AsyncMutex } from "@keel/content-shared/mutex";
import { ValidationError } from "@keel/content-shared/errors";
import { ToolBuilder, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from "./tools.js";

// Mutex to prevent race conditions during write operations
const writeMutex = new AsyncMutex();

export interface McpServerOptions {
  cwd?: string;
}

/**
 * Minimal structural view of a collection's Standard Schema validator.
 *
 * WHY structural: the engine's `CollectionSchema` is a `StandardSchemaV1`, but
 * `@standard-schema/spec` is a transitive dependency we do not declare directly.
 * We only need the `~standard.validate` entry point, so we describe exactly that
 * shape rather than pulling in the full spec package.
 */
interface StandardSchemaLike {
  "~standard": {
    validate: (value: unknown) =>
      | {
          issues?: ReadonlyArray<{
            message: string;
            path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>;
          }>;
        }
      | Promise<{
          issues?: ReadonlyArray<{
            message: string;
            path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>;
          }>;
        }>;
  };
}

/**
 * Validate frontmatter data against a collection's Standard Schema.
 *
 * Returns a human-readable issue list when validation fails, or null when the
 * data is valid. WHY: create_entry's tool description promises validation, so we
 * run the same `~standard.validate` path the parser uses before persisting —
 * otherwise we could write frontmatter that violates the collection's shape.
 */
async function validateAgainstSchema(
  schema: StandardSchemaLike,
  data: unknown,
): Promise<string | null> {
  const result = schema["~standard"].validate(data);
  const resolved = result instanceof Promise ? await result : result;

  if (!resolved.issues) {
    return null;
  }

  return resolved.issues
    .map((issue) => {
      const issuePath =
        issue.path
          ?.map((segment) =>
            typeof segment === "object" && segment !== null ? String(segment.key) : String(segment),
          )
          .join(".") || "root";
      return `  - ${issuePath}: ${issue.message}`;
    })
    .join("\n");
}

// Zod schemas for tool input validation
const TOOL_SCHEMAS = {
  list_collections: z.object({}),
  get_collection_schema: z.object({
    collection: z.string().min(1, "Collection name is required"),
  }),
  get_entry: z.object({
    collection: z.string().min(1, "Collection name is required"),
    slug: z.string().min(1, "Slug is required"),
  }),
  search_content: z.object({
    query: z.string().min(1, "Search query is required"),
    collection: z.string().optional(),
    limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
  }),
  create_entry: z.object({
    collection: z.string().min(1, "Collection name is required"),
    slug: z.string().min(1, "Slug is required"),
    data: z.record(z.string(), z.unknown()),
    content: z.string().optional(),
  }),
  update_entry: z.object({
    collection: z.string().min(1, "Collection name is required"),
    slug: z.string().min(1, "Slug is required"),
    data: z.record(z.string(), z.unknown()).optional(),
    content: z.string().optional(),
  }),
} as const;

// Infer types from schemas
type ToolSchemas = typeof TOOL_SCHEMAS;
type ToolName = keyof ToolSchemas;
type ToolArgs<T extends ToolName> = z.infer<ToolSchemas[T]>;

/**
 * Validate tool arguments against the corresponding schema.
 * Throws ValidationError if validation fails.
 */
function validateToolArgs<T extends ToolName>(toolName: T, args: unknown): ToolArgs<T> {
  const schema = TOOL_SCHEMAS[toolName];
  const result = schema.safeParse(args);
  if (!result.success) {
    throw new ValidationError(`Invalid ${toolName} arguments`, {
      tool: toolName,
      errors: result.error.flatten(),
    });
  }
  return result.data as ToolArgs<T>;
}

// Tool definitions using ToolBuilder
const TOOLS: Tool[] = [
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

function handleGetSchema(config: ResolvedConfig, args: { collection: string }): string {
  const collectionConfig = config.collections.find((c) => c.name === args.collection);

  if (!collectionConfig) {
    const available = config.collections.map((c) => c.name).join(", ");
    return `Error: Collection "${args.collection}" not found. Available collections: ${available}`;
  }

  try {
    // This package runs on zod v4; its built-in serializer reads the v4 schema
    // representation faithfully (zod-to-json-schema@3 cannot, and would emit an
    // empty schema). Collection schemas are zod schemas in practice.
    //
    // `unrepresentable: "any"` keeps types JSON Schema cannot express (notably
    // `z.date()` / `z.coerce.date()`, which are pervasive in frontmatter) from
    // throwing — they degrade to an unconstrained `{}` rather than failing the
    // whole schema lookup.
    const jsonSchema = z.toJSONSchema(collectionConfig.schema as unknown as z.ZodType, {
      unrepresentable: "any",
    });
    return JSON.stringify(jsonSchema, null, 2);
  } catch (error) {
    return `Error converting schema: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function handleGetEntry(engine: Engine, args: { collection: string; slug: string }): string {
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

function searchEntry(entry: RuntimeEntry, query: string): SearchResult | null {
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
  args: { query: string; collection?: string | undefined; limit?: number | undefined },
): string {
  const query = args.query.toLowerCase();
  const limit = args.limit ?? DEFAULT_SEARCH_LIMIT;
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

export async function handleCreateEntry(
  engine: Engine,
  config: ResolvedConfig,
  args: {
    collection: string;
    slug: string;
    data: Record<string, unknown>;
    content?: string | undefined;
  },
): Promise<string> {
  // Use mutex to prevent race conditions (TOCTOU) during create operations
  return writeMutex.runExclusive(async () => {
    // Validate slug: prevent path traversal by rejecting dangerous patterns
    const slug = args.slug;
    // Reject the special filename characters and any control character. A
    // code-point scan does this without a control-character regex.
    const hasForbiddenChar = [...(slug ?? "")].some((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || '<>:"|?*'.includes(char);
    });

    if (
      !slug ||
      slug.includes("..") ||
      slug.includes("/") ||
      slug.includes("\\") ||
      slug.startsWith(".") ||
      hasForbiddenChar
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

    // The tool description promises schema validation; actually enforce it so we
    // never write frontmatter that violates the collection's declared shape.
    const validationError = await validateAgainstSchema(
      collectionConfig.schema as unknown as StandardSchemaLike,
      args.data,
    );
    if (validationError) {
      return `Error: data does not match the "${args.collection}" schema:\n${validationError}`;
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

    const fileContent = stringify(args.data, args.content ?? "", {
      language: "yaml",
    });

    try {
      await writeFile(filePath, fileContent, "utf-8");
      // Re-scan to update engine cache after successful write
      await engine.scan();
      return `Successfully created entry at ${filePath}`;
    } catch (error) {
      return `Error writing file: ${error instanceof Error ? error.message : String(error)}`;
    }
  });
}

export async function handleUpdateEntry(
  engine: Engine,
  config: ResolvedConfig,
  args: {
    collection: string;
    slug: string;
    data?: Record<string, unknown> | undefined;
    content?: string | undefined;
  },
): Promise<string> {
  // Use mutex to prevent race conditions during update operations
  return writeMutex.runExclusive(async () => {
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

    // Extract schema data from entry, excluding reserved/engine-internal fields.
    //
    // WHY the explicit set: a RuntimeEntry carries EntryMeta fields ("id",
    // "collection", "file") spread as own-enumerable keys alongside the user's
    // frontmatter (see content-core transformer). None of those are
    // "_"-prefixed, so a "skip underscore + content/slug/rendered" filter would
    // let engine metadata — including the entire `file` DocumentMeta object —
    // leak into the persisted frontmatter on every update. Persisting them would
    // also let a later schema validation choke on fields the author never wrote.
    // Strip them all.
    const RESERVED_ENTRY_FIELDS = new Set([
      "content",
      "slug",
      "rendered",
      "id",
      "collection",
      "file",
      "mdx",
    ]);
    const entryRecord = entry as Record<string, unknown>;
    const existingData: Record<string, unknown> = {};
    for (const key of Object.keys(entryRecord)) {
      if (!key.startsWith("_") && !RESERVED_ENTRY_FIELDS.has(key)) {
        existingData[key] = entryRecord[key];
      }
    }

    const updatedData = args.data ? { ...existingData, ...args.data } : existingData;
    const existingContent = entryRecord["content"] as string | undefined;
    const updatedContent = args.content !== undefined ? args.content : (existingContent ?? "");
    const fileContent = stringify(updatedData, updatedContent, {
      language: "yaml",
    });

    try {
      await writeFile(filePath, fileContent, "utf-8");
      // Re-scan to update engine cache after successful write
      await engine.scan();
      return `Successfully updated entry at ${filePath}`;
    } catch (error) {
      return `Error writing file: ${error instanceof Error ? error.message : String(error)}`;
    }
  });
}

// Handler registry for tool dispatch
type ToolHandler = (
  engine: Engine,
  config: ResolvedConfig,
  args: Record<string, unknown>,
) => Promise<string> | string;

// Tool handlers that receive pre-validated arguments
const TOOL_HANDLERS: Record<ToolName, ToolHandler> = {
  list_collections: (engine) => handleListCollections(engine),
  get_collection_schema: (_, config, args) =>
    handleGetSchema(config, args as ToolArgs<"get_collection_schema">),
  get_entry: (engine, _, args) => handleGetEntry(engine, args as ToolArgs<"get_entry">),
  search_content: (engine, _, args) =>
    handleSearchContent(engine, args as ToolArgs<"search_content">),
  create_entry: (engine, config, args) =>
    handleCreateEntry(engine, config, args as ToolArgs<"create_entry">),
  update_entry: (engine, config, args) =>
    handleUpdateEntry(engine, config, args as ToolArgs<"update_entry">),
};

/**
 * Validate tool arguments and dispatch to the appropriate handler.
 * Throws ValidationError if arguments don't match the tool's schema.
 */
async function handleToolCall(
  engine: Engine,
  config: ResolvedConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  // Check if tool exists
  if (!(name in TOOL_SCHEMAS)) {
    return `Unknown tool: ${name}`;
  }

  const toolName = name as ToolName;

  // Validate arguments against the tool's schema
  // This throws ValidationError if validation fails
  validateToolArgs(toolName, args);

  // Dispatch to handler with validated args
  const handler = TOOL_HANDLERS[toolName];
  return handler(engine, config, args);
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
      // Handle validation errors with detailed feedback
      if (error instanceof ValidationError) {
        const errors = error.context?.["errors"];
        const details = errors ? JSON.stringify(errors, null, 2) : "";
        return {
          content: [
            {
              type: "text",
              text: `Invalid arguments for tool "${name}": ${error.message}${details ? `\n\nDetails:\n${details}` : ""}`,
            },
          ],
          isError: true,
        };
      }

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
