/**
 * A real MCP agent runs a MULTI-STEP incident response across the governed ops console.
 *
 *   bun run examples/mcp-ops-console/agent.ts             # scripted (no API key needed)
 *   ANTHROPIC_API_KEY=sk-... bun run …/agent.ts           # + Claude drives autonomously
 *
 * Fully self-contained: it boots the OpenAuth issuer and the Lesto MCP Resource Server in-process
 * (no deploy), runs a real PKCE dance for an SRE + an on-call + a viewer token, then connects the
 * actual `@modelcontextprotocol/sdk` `Client` — the same library Claude/Cursor/Inspector use —
 * over the OAuth-gated Streamable-HTTP transport. The MCP server's `handle_request` tool reaches a
 * real ops console with THREE linked domains: services, incidents, and deploys.
 *
 * What it shows:
 *   1. an SRE (mcp:read mcp:write) runs a genuine incident-response CHAIN across all three
 *      domains — survey services, declare an incident, watch a deploy get FROZEN by it, post
 *      mitigation, resolve, then watch the SAME deploy clear — a multi-step, multi-tool task
 *      whose later steps depend on the earlier writes;
 *   2. a VIEWER (mcp:read) is refused every destructive tool (403 — the scope ceiling, sourced
 *      from the OpenAuth token's `properties.scopes`);
 *   3. an ANONYMOUS agent can't even connect (401);
 *   4. with ANTHROPIC_API_KEY set, Claude is handed the same tools and runs the incident
 *      response autonomously — deciding for itself the order of operations.
 *
 * The deploy-freeze rule (a deploy is blocked while its service has an open incident) lives in the
 * domain (mcp/ops.ts), so the agent's chain is real cause-and-effect, not a scripted narration.
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
  const client = new Client({ name: "ops-console-agent", version: "0.0.0" }, { capabilities: {} });
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

/** The console as typed shapes (mirrors mcp/ops.ts). */
interface Service {
  id: string;
  name: string;
  tier: string;
  health: string;
}
interface Incident {
  id: number;
  title: string;
  severity: string;
  status: string;
  services: string[];
}
interface Deploy {
  id: number;
  service: string;
  version: string;
  status: string;
  reason: string;
}

/**
 * The scripted incident response an SRE agent runs — a real CHAIN across services → incidents →
 * deploys, where later steps observe the effects of the earlier writes.
 */
async function scriptedIncidentResponse(sre: Client): Promise<void> {
  console.log("\n── SRE runs a multi-step incident response ────────────────────");

  // 1. Survey the fleet (read).
  const services = (await call(sre, "GET", "/services")).data as { services: Service[] };
  console.log("  fleet:");
  for (const s of services.services) {
    console.log(`     • ${s.name.padEnd(12)} [${s.tier}] ${s.health}`);
  }

  // 2. A naïve deploy to a HEALTHY service ships (read the reason — the gate is real).
  const clean = (await call(sre, "POST", "/deploys", {
    body: { service: "checkout", version: "2.4.0" },
  })).data as { deploy: Deploy };
  console.log(`\n  deploy checkout@2.4.0 → ${clean.deploy.status} (${clean.deploy.reason})`);

  // 3. Declare a sev1 against checkout (write) — this is what freezes the next deploy.
  const declared = (await call(sre, "POST", "/incidents", {
    body: {
      title: "Checkout 500s on card capture",
      severity: "sev1",
      services: ["checkout", "billing"],
    },
  })).data as { incident: Incident };
  console.log(
    `\n  🚨 declared INC-${declared.incident.id}: "${declared.incident.title}" ` +
      `(${declared.incident.severity}, services: ${declared.incident.services.join(", ")})`,
  );

  // 4. The SAME deploy is now FROZEN — caused by step 3's write, not a script.
  const frozen = (await call(sre, "POST", "/deploys", {
    body: { service: "checkout", version: "2.4.1" },
  })).data as { deploy: Deploy };
  console.log(`  deploy checkout@2.4.1 → ${frozen.deploy.status.toUpperCase()} (${frozen.deploy.reason})`);

  // 5. The checkout service now reads degraded/down (the incident propagated to health).
  const checkout = (await call(sre, "GET", "/services/checkout")).data as Service;
  console.log(`  checkout health is now: ${checkout.health}`);

  // 6. Post mitigation, then resolve the incident (write, with a status transition).
  await call(sre, "POST", `/incidents/${declared.incident.id}/notes`, {
    body: { note: "rolled back card-capture flag; error rate falling", status: "mitigated" },
  });
  const resolved = (await call(sre, "POST", `/incidents/${declared.incident.id}/notes`, {
    body: { note: "error rate at baseline for 15m — resolving", status: "resolved" },
  })).data as { incident: Incident };
  console.log(`\n  📝 INC-${declared.incident.id} → ${resolved.incident.status}`);

  // 7. With the incident resolved, the deploy is CLEARED — the chain's payoff.
  const cleared = (await call(sre, "POST", "/deploys", {
    body: { service: "checkout", version: "2.4.1" },
  })).data as { deploy: Deploy };
  console.log(`  deploy checkout@2.4.1 → ${cleared.deploy.status} (${cleared.deploy.reason})`);

  console.log("\n  deploy log:");
  const deploys = (await call(sre, "GET", "/deploys")).data as { deploys: Deploy[] };
  for (const d of deploys.deploys) {
    console.log(`     • #${d.id} ${d.service}@${d.version} — ${d.status}`);
  }
}

/** The governance proof: a viewer is refused the writes, an anonymous agent can't connect. */
async function governanceProof(base: string, viewerToken: string): Promise<void> {
  console.log("\n── GOVERNANCE ─────────────────────────────────────────────────");

  const viewer = await connect(base, viewerToken);
  await viewer.listTools(); // a read-scoped client lists fine
  try {
    await viewer.callTool({
      name: "handle_request",
      arguments: { method: "POST", path: "/incidents", body: { title: "x", severity: "sev3" } },
    });
    console.log("  viewer declare-incident → UNEXPECTEDLY ALLOWED");
  } catch (error) {
    console.log(`  viewer declare-incident → refused (${(error as Error).message.split("\n")[0]})`);
  }
  await viewer.close();

  try {
    await connect(base, undefined);
    console.log("  anonymous connect → UNEXPECTEDLY ALLOWED");
  } catch (error) {
    console.log(`  anonymous connect → refused (${(error as Error).message.split("\n")[0]})`);
  }
}

/** The Claude tools — each maps to one console route, dispatched as the SRE. */
function claudeTools(): Anthropic.Tool[] {
  return [
    {
      name: "list_services",
      description: "List every service in the fleet with its tier and current health.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "list_incidents",
      description: "List incidents, optionally filtered by status (open | mitigated | resolved).",
      input_schema: {
        type: "object",
        properties: { status: { type: "string", enum: ["open", "mitigated", "resolved"] } },
      },
    },
    {
      name: "declare_incident",
      description: "Open an incident against one or more services. A privileged write.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["sev1", "sev2", "sev3"] },
          services: { type: "array", items: { type: "string" } },
        },
        required: ["title", "severity", "services"],
      },
    },
    {
      name: "annotate_incident",
      description:
        "Add a timeline note to an incident and optionally transition its status. A privileged write.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "number" },
          note: { type: "string" },
          status: { type: "string", enum: ["open", "mitigated", "resolved"] },
        },
        required: ["id", "note"],
      },
    },
    {
      name: "request_deploy",
      description:
        "Request a deploy of a version to a service. It is FROZEN while that service has an active " +
        "incident — read the returned status/reason. A privileged write.",
      input_schema: {
        type: "object",
        properties: { service: { type: "string" }, version: { type: "string" } },
        required: ["service", "version"],
      },
    },
  ];
}

/** Dispatch a Claude tool call to the console through the MCP client. */
async function runClaudeTool(sre: Client, name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "list_services":
      return (await call(sre, "GET", "/services")).data;
    case "list_incidents": {
      const query = input.status === undefined ? {} : { query: { status: String(input.status) } };

      return (await call(sre, "GET", "/incidents", query)).data;
    }
    case "declare_incident":
      return (await call(sre, "POST", "/incidents", { body: input })).data;
    case "annotate_incident":
      return (await call(sre, "POST", `/incidents/${Number(input.id)}/notes`, { body: input })).data;
    case "request_deploy":
      return (await call(sre, "POST", "/deploys", { body: input })).data;
    default:
      return { error: `unknown tool ${name}` };
  }
}

/** The Claude-driven finale: hand the agent the tools and a goal, let it run the response. */
async function claudeIncidentResponse(sre: Client): Promise<void> {
  const model = process.env.OPS_AGENT_MODEL ?? "claude-sonnet-4-6";
  console.log(`\n── CLAUDE runs the incident response (${model}) ───────────────`);

  const anthropic = new Anthropic();
  const tools = claudeTools();
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        "You're the SRE on call for an ops console. The checkout service is throwing 500s on card " +
        "capture. Declare a sev1 incident against the affected services, confirm that a pending " +
        "checkout deploy is frozen by it, then mitigate and resolve the incident and confirm the " +
        "deploy is cleared to ship. Use the tools; be concise about each step.",
    },
  ];

  for (let turn = 0; turn < 10; turn++) {
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
      const out = await runClaudeTool(sre, tu.name, tu.input as Record<string, unknown>);
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

  console.log(`ops console: OpenAuth issuer + Lesto MCP RS live (resource=${resource})`);

  // 2. Real PKCE tokens from the real dance.
  const sreToken = await getAccessToken(issuerUrl, "sre");
  const viewerToken = await getAccessToken(issuerUrl, "viewer");

  // 3. The SRE agent runs the incident-response chain across all three domains.
  const sre = await connect(base, sreToken);
  const { tools } = await sre.listTools();
  console.log(`SRE connected — ${tools.length} tools available`);
  await scriptedIncidentResponse(sre);

  // 4. Governance: viewer refused the writes, anonymous refused the connection.
  await governanceProof(base, viewerToken);

  // 5. Optional: let Claude drive the same tools autonomously.
  if (process.env.ANTHROPIC_API_KEY) {
    await claudeIncidentResponse(sre);
  } else {
    console.log("\n(set ANTHROPIC_API_KEY to watch Claude run the incident response through these tools)");
  }

  await sre.close();
  await rsServer.close();
  idpServer.close();
  close();
}

await main();
