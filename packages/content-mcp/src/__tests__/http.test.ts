import { describe, it, expect, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpHttpServer, validateToolArgs, ALL_TOOLS } from "../http";

/**
 * Tests for the Studio-HTTP-backed MCP server.
 *
 * Fix 3 (arg validation): tool arguments are validated against the advertised
 * JSON Schema before dispatch, so a missing/wrong-typed field yields a clear
 * error instead of an opaque downstream TypeError or a malformed Studio request.
 */

type FetchArgs = [input: string | URL, init: RequestInit | undefined];

interface MockRoute {
  status?: number;
  json?: unknown;
  contentType?: string;
}

/**
 * Install a fetch mock that maps "METHOD path" -> response. Unmatched routes
 * return 404. Records every call so assertions can inspect what was sent.
 */
function mockFetch(routes: Record<string, MockRoute>): {
  fetchMock: ReturnType<typeof vi.fn>;
  calls: FetchArgs[];
} {
  const calls: FetchArgs[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    calls.push([input, init]);
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.replace("http://localhost:4400", "");
    const route = routes[`${method} ${path}`];

    const status = route?.status ?? (route ? 200 : 404);
    const body = route?.json ?? (route ? {} : { error: "not found" });
    const contentType = route?.contentType ?? "application/json";

    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => (name === "content-type" ? contentType : null) },
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

async function connectClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = await createMcpHttpServer({ studioUrl: "http://localhost:4400" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

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

const FULL_CAPS = { content: true, voice: true, ai: true, git: true };

describe("validateToolArgs", () => {
  it("rejects missing required arguments", () => {
    const tool = ALL_TOOLS["get_entry"]!;
    const error = validateToolArgs(tool, { collection: "posts" });
    expect(error).toContain('Missing required argument "slug"');
  });

  it("rejects a wrong-typed required argument", () => {
    const tool = ALL_TOOLS["search_content"]!;
    const error = validateToolArgs(tool, { query: 123 });
    expect(error).toContain('Argument "query"');
    expect(error).toContain("string");
  });

  it("rejects a wrong-typed optional argument", () => {
    const tool = ALL_TOOLS["search_content"]!;
    const error = validateToolArgs(tool, { query: "hi", limit: "ten" });
    expect(error).toContain('Argument "limit"');
  });

  it("accepts valid arguments", () => {
    const tool = ALL_TOOLS["search_content"]!;
    const error = validateToolArgs(tool, { query: "hi", limit: 5, collection: "posts" });
    expect(error).toBeNull();
  });

  it("accepts object-typed and array-typed arguments", () => {
    const create = ALL_TOOLS["create_entry"]!;
    expect(validateToolArgs(create, { collection: "p", slug: "s", data: { a: 1 } })).toBeNull();

    const training = ALL_TOOLS["voice_training_prepare"]!;
    expect(validateToolArgs(training, { collection: "p", instructionTypes: ["write"] })).toBeNull();
  });

  it("ignores null-valued arguments when type-checking", () => {
    const tool = ALL_TOOLS["search_content"]!;
    expect(validateToolArgs(tool, { query: "hi", collection: null })).toBeNull();
  });

  it("accepts a no-params tool with no declared properties", () => {
    const tool = ALL_TOOLS["ai_status"]!;
    expect(validateToolArgs(tool, {})).toBeNull();
    // An undeclared extra arg has no declared type -> skipped, not rejected.
    expect(validateToolArgs(tool, { extra: 1 })).toBeNull();
  });

  it("accepts an array-typed declared field (instructionTypes)", () => {
    const tool = ALL_TOOLS["voice_training_prepare"]!;
    expect(
      validateToolArgs(tool, { collection: "p", instructionTypes: ["write", "explain"] }),
    ).toBeNull();
  });
});

describe("createMcpHttpServer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns when Studio is not running but still advertises all tools", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch({}); // every route 404, health check fails -> not running

    const { client, close } = await connectClient();
    try {
      const tools = await client.listTools();
      // With unknown capabilities the server advertises every tool (it cannot
      // know what Studio supports yet); the only "degradation" is the warning.
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("list_collections");
      expect(names).toContain("voice_generate");
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Studio API is not running"));
    } finally {
      await close();
    }
  });

  it("hides voice and AI tools when Studio reports those capabilities as off", async () => {
    mockFetch({
      "GET /api/health": { json: { ok: true } },
      "GET /api/capabilities": { json: { content: true, voice: false, ai: false, git: false } },
    });
    const { client, close } = await connectClient();
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("list_collections");
      expect(names).toContain("quality_lint");
      expect(names).not.toContain("get_voice_profile");
      expect(names).not.toContain("voice_generate");
      expect(names).not.toContain("ai_status");
    } finally {
      await close();
    }
  });

  it("shows voice tools but hides AI tools when only AI is off", async () => {
    mockFetch({
      "GET /api/health": { json: { ok: true } },
      "GET /api/capabilities": { json: { content: true, voice: true, ai: false, git: false } },
    });
    const { client, close } = await connectClient();
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("get_voice_profile");
      expect(names).not.toContain("voice_generate");
      expect(names).not.toContain("ai_status");
    } finally {
      await close();
    }
  });

  it("lists capability-gated tools when Studio reports them", async () => {
    mockFetch({
      "GET /api/health": { json: { ok: true } },
      "GET /api/capabilities": { json: FULL_CAPS },
    });

    const { client, close } = await connectClient();
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("voice_generate");
      expect(names).toContain("ai_status");
      expect(names).toContain("quality_lint");
    } finally {
      await close();
    }
  });

  it("rejects a call with a missing required argument before dispatch", async () => {
    mockFetch({
      "GET /api/health": { json: { ok: true } },
      "GET /api/capabilities": { json: FULL_CAPS },
    });

    const { client, close } = await connectClient();
    try {
      const { text } = await callTool(client, "get_entry", { collection: "posts" });
      expect(text).toContain('Missing required argument "slug"');
    } finally {
      await close();
    }
  });

  it("reports an unknown tool", async () => {
    mockFetch({
      "GET /api/health": { json: { ok: true } },
      "GET /api/capabilities": { json: FULL_CAPS },
    });
    const { client, close } = await connectClient();
    try {
      const { text } = await callTool(client, "does_not_exist", {});
      expect(text).toContain("Unknown tool");
    } finally {
      await close();
    }
  });

  it("exercises the content + voice + ai + quality handlers over HTTP", async () => {
    const entry = {
      slug: "hello",
      collection: "posts",
      data: { title: "Hello" },
      content: "the body mentions widgets",
    };
    mockFetch({
      "GET /api/health": { json: { ok: true } },
      "GET /api/capabilities": { json: FULL_CAPS },
      "GET /api/collections": {
        json: { collections: [{ name: "posts", entries: [{ slug: "hello" }] }] },
      },
      "GET /api/collections/posts/schema": { json: { fields: [] } },
      "GET /api/collections/posts/hello": { json: entry },
      "POST /api/entries": { json: { success: true, filePath: "content/posts/new.md" } },
      "PUT /api/collections/posts/hello": { json: { success: true } },
      "DELETE /api/collections/posts/hello": { json: { success: true } },
      "GET /api/voice/posts": { json: { collection: "posts", sampleCount: 1, systemPrompt: "x" } },
      "GET /api/voice/posts/samples": {
        json: { collection: "posts", sampleCount: 0, samples: [] },
      },
      "GET /api/voice/posts/status": { json: { configured: true } },
      "POST /api/voice/posts/training": {
        json: { collection: "posts", stats: { totalPairs: 0 } },
      },
      "POST /api/ai": { json: { text: "generated" } },
      "GET /api/ai/status": { json: { configured: true } },
      "POST /api/quality/lint": { json: { valid: true, errors: [], warnings: [] } },
      "POST /api/quality/a11y": { json: { diagnostics: [], errorCount: 0, warningCount: 0 } },
    });

    const { client, close } = await connectClient();
    try {
      expect((await callTool(client, "list_collections", {})).text).toContain("posts");
      expect(
        (await callTool(client, "get_collection_schema", { collection: "posts" })).text,
      ).toContain("fields");
      expect(
        (await callTool(client, "get_entry", { collection: "posts", slug: "hello" })).text,
      ).toContain("Hello");
      expect((await callTool(client, "search_content", { query: "widgets" })).text).toContain(
        "hello",
      );
      expect((await callTool(client, "search_content", { query: "title" })).text).toContain(
        "Data contains",
      );
      expect(
        (await callTool(client, "search_content", { query: "nothingmatches", collection: "posts" }))
          .text,
      ).toContain("No results");
      expect(
        (
          await callTool(client, "create_entry", {
            collection: "posts",
            slug: "new",
            data: { title: "x" },
          })
        ).text,
      ).toContain("Successfully created");
      expect(
        (
          await callTool(client, "update_entry", {
            collection: "posts",
            slug: "hello",
            data: { title: "y" },
          })
        ).text,
      ).toContain("Successfully updated");
      expect(
        (await callTool(client, "delete_entry", { collection: "posts", slug: "hello" })).text,
      ).toContain("Successfully deleted");
      expect((await callTool(client, "get_voice_profile", { collection: "posts" })).text).toContain(
        "systemPrompt",
      );
      expect((await callTool(client, "get_voice_samples", { collection: "posts" })).text).toContain(
        "sampleCount",
      );
      expect((await callTool(client, "get_voice_status", { collection: "posts" })).text).toContain(
        "configured",
      );
      expect(
        (await callTool(client, "voice_generate", { collection: "posts", prompt: "hi" })).text,
      ).toContain("generated");
      expect(
        (await callTool(client, "voice_check", { collection: "posts", content: "abc" })).text,
      ).toContain("generated");
      expect(
        (await callTool(client, "voice_training_prepare", { collection: "posts" })).text,
      ).toContain("stats");
      expect((await callTool(client, "ai_status", {})).text).toContain("configured");
      expect((await callTool(client, "quality_lint", { content: "abc" })).text).toContain("valid");
      expect(
        (await callTool(client, "quality_a11y", { content: "abc", skipLinks: true })).text,
      ).toContain("diagnostics");
    } finally {
      await close();
    }
  });

  it("surfaces Studio error responses through each handler", async () => {
    mockFetch({
      "GET /api/health": { json: { ok: true } },
      "GET /api/capabilities": { json: FULL_CAPS },
      // collections returns an error for list/search error branches
      "GET /api/collections": { status: 500, json: { error: "boom" } },
      "GET /api/collections/posts/schema": { status: 500, json: { error: "boom" } },
      "GET /api/collections/posts/hello": { status: 404, json: { error: "missing" } },
      "POST /api/entries": { status: 500, json: { error: "boom" } },
      "PUT /api/collections/posts/hello": { status: 500, json: { error: "boom" } },
      "DELETE /api/collections/posts/hello": { status: 500, json: { error: "boom" } },
      "GET /api/voice/posts": { status: 500, json: { error: "boom" } },
      "GET /api/voice/posts/samples": { status: 500, json: { error: "boom" } },
      "GET /api/voice/posts/status": { status: 500, json: { error: "boom" } },
      "POST /api/voice/posts/training": { status: 500, json: { error: "boom" } },
      "POST /api/ai": { status: 500, json: { error: "boom" } },
      "GET /api/ai/status": { status: 500, json: { error: "boom" } },
      "POST /api/quality/lint": { status: 500, json: { error: "boom" } },
      "POST /api/quality/a11y": { status: 500, json: { error: "boom" } },
    });

    const { client, close } = await connectClient();
    try {
      expect((await callTool(client, "list_collections", {})).text).toContain("Error");
      expect(
        (await callTool(client, "get_collection_schema", { collection: "posts" })).text,
      ).toContain("Error");
      expect(
        (await callTool(client, "get_entry", { collection: "posts", slug: "hello" })).text,
      ).toContain("not found");
      expect((await callTool(client, "search_content", { query: "x" })).text).toContain("Error");
      expect(
        (await callTool(client, "create_entry", { collection: "posts", slug: "n", data: {} })).text,
      ).toContain("Error");
      expect(
        (await callTool(client, "update_entry", { collection: "posts", slug: "hello" })).text,
      ).toContain("Error");
      expect(
        (await callTool(client, "delete_entry", { collection: "posts", slug: "hello" })).text,
      ).toContain("Error");
      expect((await callTool(client, "get_voice_profile", { collection: "posts" })).text).toContain(
        "Error",
      );
      expect((await callTool(client, "get_voice_samples", { collection: "posts" })).text).toContain(
        "Error",
      );
      expect((await callTool(client, "get_voice_status", { collection: "posts" })).text).toContain(
        "Error",
      );
      expect(
        (await callTool(client, "voice_generate", { collection: "posts", prompt: "x" })).text,
      ).toContain("Error");
      expect(
        (await callTool(client, "voice_check", { collection: "posts", content: "x" })).text,
      ).toContain("Error");
      expect(
        (await callTool(client, "voice_training_prepare", { collection: "posts" })).text,
      ).toContain("Error");
      // ai_status returns a JSON object with configured:false on error
      expect((await callTool(client, "ai_status", {})).text).toContain("false");
      expect((await callTool(client, "quality_lint", { content: "x" })).text).toContain("Error");
      expect((await callTool(client, "quality_a11y", { content: "x" })).text).toContain("Error");
    } finally {
      await close();
    }
  });

  it("covers fallback branches: entry without content, create without filePath, empty AI text", async () => {
    mockFetch({
      "GET /api/health": { json: { ok: true } },
      "GET /api/capabilities": { json: FULL_CAPS },
      "GET /api/collections": {
        json: { collections: [{ name: "posts", entries: [{ slug: "nc" }] }] },
      },
      // Entry has no `content` field -> searchEntryData falls back to data match.
      "GET /api/collections/posts/nc": {
        json: { slug: "nc", collection: "posts", data: { title: "kw" } },
      },
      // create response omits filePath -> handler uses the collection/slug fallback.
      "POST /api/entries": { json: { success: true } },
      // AI response omits `text` -> handlers return "".
      "POST /api/ai": { json: {} },
    });

    const { client, close } = await connectClient();
    try {
      const search = await callTool(client, "search_content", { query: "kw" });
      expect(search.text).toContain("Data contains");

      const created = await callTool(client, "create_entry", {
        collection: "posts",
        slug: "made",
        data: { title: "x" },
      });
      expect(created.text).toContain("posts/made");

      const generated = await callTool(client, "voice_generate", {
        collection: "posts",
        prompt: "p",
      });
      expect(generated.text).toBe("");
      const checked = await callTool(client, "voice_check", { collection: "posts", content: "c" });
      expect(checked.text).toBe("");
    } finally {
      await close();
    }
  });

  it("skips entries that fail to fetch and stops at the search limit", async () => {
    mockFetch({
      "GET /api/health": { json: { ok: true } },
      "GET /api/capabilities": { json: FULL_CAPS },
      "GET /api/collections": {
        json: {
          collections: [
            { name: "posts", entries: [{ slug: "broken" }, { slug: "a" }, { slug: "b" }] },
          ],
        },
      },
      // "broken" fetch fails -> the loop `continue`s past it (line 365).
      "GET /api/collections/posts/broken": { status: 500, json: { error: "x" } },
      "GET /api/collections/posts/a": {
        json: { slug: "a", collection: "posts", data: {}, content: "match here" },
      },
      "GET /api/collections/posts/b": {
        json: { slug: "b", collection: "posts", data: {}, content: "match here too" },
      },
    });

    const { client, close } = await connectClient();
    try {
      // limit 1 -> only one result even though two would match (line 375 break).
      const { text } = await callTool(client, "search_content", { query: "match", limit: 1 });
      const parsed = JSON.parse(text) as unknown[];
      expect(parsed).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("ignores a non-ok capabilities response and still serves tools", async () => {
    mockFetch({
      "GET /api/health": { json: { ok: true } },
      "GET /api/capabilities": { status: 500, json: { error: "no caps" } },
    });
    const { client, close } = await connectClient();
    try {
      const tools = await client.listTools();
      // No capabilities resolved -> undefined -> all tools advertised.
      expect(tools.tools.map((t) => t.name)).toContain("voice_generate");
    } finally {
      await close();
    }
  });

  it("returns the empty-collections message and handles search no-content branch", async () => {
    mockFetch({
      "GET /api/health": { json: { ok: true } },
      "GET /api/capabilities": { json: FULL_CAPS },
      "GET /api/collections": { json: { collections: [] } },
    });
    const { client, close } = await connectClient();
    try {
      expect((await callTool(client, "list_collections", {})).text).toContain("No collections");
      expect((await callTool(client, "search_content", { query: "x" })).text).toContain(
        "No results",
      );
    } finally {
      await close();
    }
  });
});
