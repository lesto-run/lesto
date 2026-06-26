/**
 * A real MCP agent scouts live MLB data through the OAuth-gated Lesto server.
 *
 *   bun run examples/mcp-auth-openauth/agent.ts            # scripted (no API key needed)
 *   ANTHROPIC_API_KEY=sk-... bun run …/agent.ts            # + Claude drives autonomously
 *
 * Fully self-contained: it boots the OpenAuth issuer and the Lesto MCP Resource Server in-process
 * (no deploy), runs a real PKCE dance for an operator + a viewer token, then connects the actual
 * `@modelcontextprotocol/sdk` `Client` — the same library Claude/Cursor/Inspector use — over the
 * OAuth-gated Streamable-HTTP transport. The MCP server's `handle_request` tool reaches a scout's
 * console backed by the LIVE MLB Stats API (statsapi.mlb.com, public, no key).
 *
 * What it shows:
 *   1. an OPERATOR (mcp:read mcp:write) investigates live MLB data across several tool calls and
 *      writes a prospect to a scouting board — a genuine multi-step agent task;
 *   2. a VIEWER (mcp:read) is refused the destructive `handle_request` tool (403, the scope
 *      ceiling sourced from the OpenAuth token's `properties.scopes`);
 *   3. an ANONYMOUS agent can't even connect (401);
 *   4. with ANTHROPIC_API_KEY set, Claude is handed the same tools and scouts autonomously —
 *      deciding for itself which MLB queries to run and whom to add to the board.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { serve as honoServe } from "@hono/node-server";
import Anthropic from "@anthropic-ai/sdk";

import { openSqlite, serve } from "@lesto/runtime";

import { issuerApp } from "./idp/issuer";
import { CLIENT_ID, getAccessToken } from "./idp/dance";
import { buildRs, demoRolesOf } from "./mcp/app";

/** Connect a real MCP client to `${base}/mcp`, presenting `token` as a bearer (or none). */
async function connect(base: string, token: string | undefined): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    // A non-browser agent presents its bearer on the Authorization header and sends no Origin.
    requestInit: token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "mlb-scout-agent", version: "0.0.0" }, { capabilities: {} });
  // `exactOptionalPropertyTypes` vs the SDK: the transport's `get sessionId()` getter doesn't
  // structurally satisfy `Transport`'s `sessionId?: string`; it IS a Transport, so cast.
  await client.connect(transport as Transport);

  return client;
}

/** One app call through the MCP `handle_request` tool → the app's parsed JSON response. */
async function call(
  client: Client,
  method: string,
  path: string,
  opts: { query?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; data: unknown }> {
  const args: Record<string, unknown> = { method, path };
  if (opts.query !== undefined) args.query = opts.query;
  if (opts.body !== undefined) args.body = opts.body;

  const result = await client.callTool({ name: "handle_request", arguments: args }, CallToolResultSchema);
  // handle_request returns the app's `{ status, headers, body }`; `body` is itself a JSON string.
  const wrapped = JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}") as {
    status: number;
    body: string;
  };

  return { status: wrapped.status, data: JSON.parse(wrapped.body || "null") };
}

/** The scout's console as typed shapes (mirrors mcp/mlb.ts + the scouting board). */
interface Standings {
  divisions: { division: string; teams: { rank: number; team: string; wins: number; losses: number }[] }[];
}
interface PlayerSearch {
  players: { id: number; name: string; position: string }[];
}
interface SeasonHitting {
  season: string;
  homeRuns: number;
  rbi: number;
  avg: string;
  ops: string;
  hits: number;
  stolenBases: number;
}

/** The scripted investigation an operator agent runs — multi-step, against live MLB. */
async function scriptedScouting(operator: Client): Promise<void> {
  console.log("\n── OPERATOR investigates live MLB ──────────────────────────────");

  const standings = (await call(operator, "GET", "/standings", { query: { league: "AL", season: "2024" } }))
    .data as Standings;
  for (const div of standings.divisions) {
    const lead = div.teams.find((t) => t.rank === 1) ?? div.teams[0];
    console.log(`  ${div.division.padEnd(11)} leader: ${lead?.team} (${lead?.wins}-${lead?.losses})`);
  }

  const search = (await call(operator, "GET", "/players", { query: { q: "Bobby Witt Jr" } })).data as PlayerSearch;
  const player = search.players[0];
  if (player === undefined) throw new Error("no player found");
  console.log(`\n  searched "Bobby Witt Jr" → ${player.name} (${player.position}, id ${player.id})`);

  const stats = (await call(operator, "GET", `/players/${player.id}/stats`, { query: { season: "2024" } }))
    .data as SeasonHitting;
  console.log(
    `  ${player.name} 2024: ${stats.homeRuns} HR, ${stats.rbi} RBI, ${stats.avg} AVG, ${stats.ops} OPS, ${stats.stolenBases} SB`,
  );

  const added = await call(operator, "POST", "/scouting", {
    body: { playerId: player.id, name: player.name, note: `2024: ${stats.homeRuns} HR / ${stats.ops} OPS` },
  });
  console.log(`\n  ✍️  POST /scouting → ${added.status} (operator write allowed)`);

  const board = (await call(operator, "GET", "/scouting")).data as { board: { name: string; note: string }[] };
  console.log("  📋 scouting board:");
  for (const e of board.board) console.log(`     • ${e.name} — ${e.note}`);
}

/** The governance proof: a viewer is refused the write, an anonymous agent can't connect. */
async function governanceProof(base: string, viewerToken: string): Promise<void> {
  console.log("\n── GOVERNANCE ─────────────────────────────────────────────────");

  const viewer = await connect(base, viewerToken);
  await viewer.listTools(); // a read-scoped client lists fine
  try {
    await viewer.callTool({
      name: "handle_request",
      arguments: { method: "POST", path: "/scouting", body: { playerId: 1, name: "x" } },
    });
    console.log("  viewer write → UNEXPECTEDLY ALLOWED");
  } catch (error) {
    console.log(`  viewer write → refused (${(error as Error).message.split("\n")[0]})`);
  }
  await viewer.close();

  try {
    await connect(base, undefined);
    console.log("  anonymous connect → UNEXPECTEDLY ALLOWED");
  } catch (error) {
    console.log(`  anonymous connect → refused (${(error as Error).message.split("\n")[0]})`);
  }
}

/** The Claude tools — each maps to one app route, dispatched as the operator. */
function claudeTools(): Anthropic.Tool[] {
  return [
    {
      name: "mlb_standings",
      description: "Current MLB regular-season standings for a league, by division.",
      input_schema: {
        type: "object",
        properties: { league: { type: "string", enum: ["AL", "NL"] }, season: { type: "string" } },
      },
    },
    {
      name: "search_players",
      description: "Search MLB players by (partial) name; returns their id and position.",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    {
      name: "player_stats",
      description: "A player's season hitting line (HR, RBI, AVG, OPS, …) by player id.",
      input_schema: {
        type: "object",
        properties: { playerId: { type: "number" }, season: { type: "string" } },
        required: ["playerId"],
      },
    },
    {
      name: "add_to_scouting_board",
      description: "Add a player to the scouting board with a short note. The privileged write.",
      input_schema: {
        type: "object",
        properties: { playerId: { type: "number" }, name: { type: "string" }, note: { type: "string" } },
        required: ["playerId", "name", "note"],
      },
    },
    {
      name: "view_scouting_board",
      description: "Read the current scouting board.",
      input_schema: { type: "object", properties: {} },
    },
  ];
}

/** Dispatch a Claude tool call to the app through the MCP client. */
async function runClaudeTool(operator: Client, name: string, input: Record<string, unknown>): Promise<unknown> {
  const season = String(input.season ?? "2024");
  switch (name) {
    case "mlb_standings":
      return (await call(operator, "GET", "/standings", { query: { league: String(input.league ?? "AL"), season } })).data;
    case "search_players":
      return (await call(operator, "GET", "/players", { query: { q: String(input.query ?? "") } })).data;
    case "player_stats":
      return (await call(operator, "GET", `/players/${Number(input.playerId)}/stats`, { query: { season } })).data;
    case "add_to_scouting_board":
      return (await call(operator, "POST", "/scouting", { body: input })).data;
    case "view_scouting_board":
      return (await call(operator, "GET", "/scouting")).data;
    default:
      return { error: `unknown tool ${name}` };
  }
}

/** The Claude-driven finale: hand the agent the tools and a goal, let it scout autonomously. */
async function claudeScouting(operator: Client): Promise<void> {
  const model = process.env.MLB_AGENT_MODEL ?? "claude-sonnet-4-6";
  console.log(`\n── CLAUDE scouts autonomously (${model}) ──────────────────────`);

  const anthropic = new Anthropic();
  const tools = claudeTools();
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        "You're an MLB scout with live data tools. Find the American League's standout shortstop " +
        "from the 2024 season and add them to my scouting board with a one-line note on why. " +
        "Use the tools; be concise.",
    },
  ];

  for (let turn = 0; turn < 8; turn++) {
    const resp = await anthropic.messages.create({ model, max_tokens: 1024, tools, messages });

    for (const block of resp.content) {
      if (block.type === "text" && block.text.trim() !== "") console.log(`  🤖 ${block.text.trim()}`);
    }

    const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) break;

    messages.push({ role: "assistant", content: resp.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      console.log(`     ↳ ${tu.name}(${JSON.stringify(tu.input)})`);
      const out = await runClaudeTool(operator, tu.name, tu.input as Record<string, unknown>);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
  }
}

async function main(): Promise<void> {
  // 1. Boot the OpenAuth issuer + the Lesto MCP RS in-process.
  const idpServer = await new Promise<ReturnType<typeof honoServe>>((resolve) => {
    const s = honoServe({ fetch: issuerApp.fetch, port: 0 }, () => resolve(s));
  });
  const issuerUrl = `http://localhost:${(idpServer.address() as { port: number }).port}`;

  const { db: handle, close } = await openSqlite();
  const { app, resource } = await buildRs({
    handle,
    issuer: issuerUrl,
    jwksUrl: new URL(`${issuerUrl}/.well-known/jwks.json`),
    clientID: CLIENT_ID,
    baseUrl: "http://rs.example.test",
    allowedOrigins: [],
    rolesOf: demoRolesOf,
  });
  // Quiet the per-request access log so the agent's narration reads clean (it's a demo).
  const rsServer = await serve(app, { port: 0, logRequest: () => {} });
  const base = `http://127.0.0.1:${rsServer.port}`;

  console.log(`MLB scout: OpenAuth issuer + Lesto MCP RS live (resource=${resource})`);

  // 2. Real PKCE tokens from the real dance.
  const operatorToken = await getAccessToken(issuerUrl, "operator");
  const viewerToken = await getAccessToken(issuerUrl, "viewer");

  // 3. The operator agent investigates live MLB and writes to the board.
  const operator = await connect(base, operatorToken);
  const { tools } = await operator.listTools();
  console.log(`operator connected — ${tools.length} tools available`);
  await scriptedScouting(operator);

  // 4. Governance: viewer refused the write, anonymous refused the connection.
  await governanceProof(base, viewerToken);

  // 5. Optional: let Claude drive the same tools autonomously.
  if (process.env.ANTHROPIC_API_KEY) {
    await claudeScouting(operator);
  } else {
    console.log("\n(set ANTHROPIC_API_KEY to watch Claude scout autonomously through these tools)");
  }

  await operator.close();
  await rsServer.close();
  idpServer.close();
  close();
}

await main();
