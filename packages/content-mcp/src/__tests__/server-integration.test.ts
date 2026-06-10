import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server";
import { createTempDir, type TempDirContext } from "./test-utils";

// Root temp projects inside the package so the docks.config.ts can resolve
// "zod" through the monorepo's node_modules.
const PACKAGE_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * End-to-end coverage for the standalone MCP server: it loads a real
 * docks.config, scans a temp project, and answers tool calls over an in-memory
 * transport. This exercises the read handlers, the validation/dispatch path,
 * and the request-handler error boundary.
 */

const DOCKS_CONFIG = `import { z } from "zod";

export default {
  collections: [
    {
      name: "posts",
      directory: "content/posts",
      schema: z.object({
        title: z.string(),
        publishedAt: z.coerce.date(),
        draft: z.boolean().optional(),
      }),
    },
  ],
  mode: "development",
};
`;

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  return { text: res.content[0]?.text ?? "", isError: res.isError ?? false };
}

describe("createMcpServer end-to-end", () => {
  let ctx: TempDirContext;
  let tempDir: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ctx = await createTempDir("mcp-server-int-", PACKAGE_DIR);
    tempDir = ctx.tempDir;

    await mkdir(join(tempDir, "content", "posts"), { recursive: true });
    await writeFile(join(tempDir, "docks.config.ts"), DOCKS_CONFIG);
    await writeFile(
      join(tempDir, "content", "posts", "hello-world.md"),
      `---\ntitle: "Hello World"\npublishedAt: 2024-01-15\ndraft: false\n---\n\nThis post mentions widgets.`,
    );

    const server = await createMcpServer({ cwd: tempDir });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);

    close = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await close();
    await ctx.cleanup();
    vi.restoreAllMocks();
  });

  it("lists the configured tools", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_collections",
        "get_collection_schema",
        "get_entry",
        "search_content",
        "create_entry",
        "update_entry",
      ]),
    );
  });

  it("list_collections reports the seeded entry", async () => {
    const { text } = await callTool(client, "list_collections", {});
    expect(text).toContain("posts");
    expect(text).toContain("hello-world");
  });

  it("get_collection_schema returns JSON Schema, and errors on unknown collection", async () => {
    const ok = await callTool(client, "get_collection_schema", { collection: "posts" });
    expect(ok.text).toContain("title");

    const bad = await callTool(client, "get_collection_schema", { collection: "ghosts" });
    expect(bad.text).toContain("not found");
  });

  it("get_entry returns an entry, and a not-found message otherwise", async () => {
    const ok = await callTool(client, "get_entry", { collection: "posts", slug: "hello-world" });
    expect(ok.text).toContain("Hello World");

    const bad = await callTool(client, "get_entry", { collection: "posts", slug: "ghost" });
    expect(bad.text).toContain("Entry not found");
  });

  it("search_content finds content matches, data matches, scoped, and no-match", async () => {
    const contentHit = await callTool(client, "search_content", { query: "widgets" });
    expect(contentHit.text).toContain("hello-world");

    const dataHit = await callTool(client, "search_content", { query: "hello world", limit: 5 });
    expect(dataHit.text).toContain("hello-world");

    const scoped = await callTool(client, "search_content", {
      query: "widgets",
      collection: "posts",
    });
    expect(scoped.text).toContain("hello-world");

    const miss = await callTool(client, "search_content", { query: "zzzznomatch" });
    expect(miss.text).toContain("No results");
  });

  it("validates arguments before dispatch and reports unknown tools", async () => {
    // Missing required slug -> ValidationError surfaced as isError.
    const missing = await callTool(client, "get_entry", { collection: "posts" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("Invalid arguments");

    const unknown = await callTool(client, "totally_unknown", {});
    expect(unknown.text).toContain("Unknown tool");
  });

  it("creates then updates an entry through the live engine", async () => {
    const created = await callTool(client, "create_entry", {
      collection: "posts",
      slug: "fresh",
      data: { title: "Fresh", publishedAt: "2024-03-01" },
      content: "Fresh body.",
    });
    expect(created.text).toContain("Successfully created");

    // Update content (exercises the content-replacement branch)...
    const contentUpdate = await callTool(client, "update_entry", {
      collection: "posts",
      slug: "fresh",
      content: "Replaced body.",
    });
    expect(contentUpdate.text).toContain("Successfully updated");

    // ...then a data-only update (exercises the existing-content default branch).
    const updated = await callTool(client, "update_entry", {
      collection: "posts",
      slug: "fresh",
      data: { title: "Fresher" },
    });
    expect(updated.text).toContain("Successfully updated");
  });
});

const MULTI_CONFIG = `import { z } from "zod";

export default {
  collections: [
    {
      name: "posts",
      directory: "content/posts",
      schema: z.object({ title: z.string() }),
    },
    {
      name: "empty",
      directory: "content/empty",
      schema: z.object({ title: z.string() }),
    },
  ],
  mode: "development",
};
`;

describe("createMcpServer search and edge branches", () => {
  let ctx: TempDirContext;
  let tempDir: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ctx = await createTempDir("mcp-server-multi-", PACKAGE_DIR);
    tempDir = ctx.tempDir;

    await mkdir(join(tempDir, "content", "posts"), { recursive: true });
    await mkdir(join(tempDir, "content", "empty"), { recursive: true });
    await writeFile(join(tempDir, "docks.config.ts"), MULTI_CONFIG);

    // Two posts so the search limit can be hit at limit=1.
    await writeFile(
      join(tempDir, "content", "posts", "alpha.md"),
      `---\ntitle: "Alpha"\n---\n\nshared keyword here.`,
    );
    await writeFile(
      join(tempDir, "content", "posts", "beta.md"),
      `---\ntitle: "Beta"\n---\n\nshared keyword here too.`,
    );
    // A frontmatter-only entry: searching it exercises the empty-content path
    // (the `|| ""` fallback when an entry has no markdown body).
    await writeFile(
      join(tempDir, "content", "posts", "bodyless.md"),
      `---\ntitle: "Bodyless"\n---\n`,
    );

    const server = await createMcpServer({ cwd: tempDir });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    close = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await close();
    await ctx.cleanup();
  });

  it("stops collecting search results once the limit is reached", async () => {
    const { text } = await callTool(client, "search_content", { query: "keyword", limit: 1 });
    const parsed = JSON.parse(text) as unknown[];
    expect(parsed).toHaveLength(1);
  });

  it("matches a body-less entry by its frontmatter data", async () => {
    const { text } = await callTool(client, "search_content", { query: "bodyless" });
    expect(text).toContain("bodyless");
    expect(text).toContain("Entry contains");
  });
});

describe("createMcpServer schema-conversion failure", () => {
  let ctx: TempDirContext;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ctx = await createTempDir("mcp-server-badschema-", PACKAGE_DIR);
    const tempDir = ctx.tempDir;
    await mkdir(join(tempDir, "content", "posts"), { recursive: true });
    await writeFile(join(tempDir, "content", "posts", "x.md"), `---\ntitle: "X"\n---\n\nbody`);

    // A non-zod Standard Schema. The engine accepts it (it only needs
    // ~standard.validate), but zod's toJSONSchema cannot serialize it, so
    // get_collection_schema must surface a conversion error rather than crash.
    await writeFile(
      join(tempDir, "docks.config.ts"),
      `const schema = { "~standard": { version: 1, vendor: "test", validate: (v) => ({ value: v }) } };\n` +
        `export default { collections: [{ name: "posts", directory: "content/posts", schema }], mode: "development" };\n`,
    );

    const server = await createMcpServer({ cwd: tempDir });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    close = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await close();
    await ctx.cleanup();
  });

  it("returns a conversion error for a non-serializable schema", async () => {
    const { text } = await callTool(client, "get_collection_schema", { collection: "posts" });
    expect(text).toContain("Error converting schema");
  });
});

describe("createMcpServer with no entries", () => {
  let ctx: TempDirContext;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ctx = await createTempDir("mcp-server-none-", PACKAGE_DIR);
    const tempDir = ctx.tempDir;

    // A config whose single collection points at a directory with no files.
    await mkdir(join(tempDir, "content", "empty"), { recursive: true });
    await writeFile(
      join(tempDir, "docks.config.ts"),
      `import { z } from "zod";\nexport default { collections: [{ name: "empty", directory: "content/empty", schema: z.object({ title: z.string() }) }], mode: "development" };\n`,
    );

    const server = await createMcpServer({ cwd: tempDir });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    close = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await close();
    await ctx.cleanup();
  });

  it("list_collections reports the no-collections message when none have entries", async () => {
    // The engine surfaces no collections when none contain entries, so
    // list_collections returns its empty-state guidance.
    const { text } = await callTool(client, "list_collections", {});
    expect(text).toContain("No collections found");
  });

  it("search_content over an empty collection returns no results", async () => {
    const { text } = await callTool(client, "search_content", { query: "anything" });
    expect(text).toContain("No results");
  });
});
