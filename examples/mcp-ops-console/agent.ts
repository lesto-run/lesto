/**
 * A real MCP agent runs a MULTI-STEP incident response across the governed ops console.
 *
 *   bun run examples/mcp-ops-console/agent.ts             # scripted (no API key needed)
 *   ANTHROPIC_API_KEY=sk-... bun run …/agent.ts           # + Claude drives autonomously
 *
 * Fully self-contained: it boots the OpenAuth issuer and the Lesto MCP Resource Server in-process
 * (no deploy), runs a real PKCE dance for an SRE + an on-call + a viewer + a stakeholder token, then
 * connects the actual `@modelcontextprotocol/sdk` `Client` — the same library Claude/Cursor/Inspector
 * use — over the OAuth-gated Streamable-HTTP transport. The console exposes its real actions as
 * FIRST-CLASS domain tools (ADR 0043): `declare_incident` / `annotate_incident` / `gate_deploy`
 * writes and `list_services` / `list_deploys` reads, each owning its own per-tool policy floor. The
 * generic `handle_request` is omitted (least privilege), so an agent reaches exactly these actions.
 *
 * What it shows:
 *   1. an SRE (mcp:read mcp:write) runs a genuine incident-response CHAIN across all three
 *      domains — survey services, declare an incident, watch a deploy get FROZEN by it, post
 *      mitigation, resolve, then watch the SAME deploy clear — a multi-step, multi-tool task
 *      whose later steps depend on the earlier writes;
 *   2. a VIEWER (mcp:read) is refused every write by the SCOPE ceiling (403);
 *   3. an over-scoped STAKEHOLDER (mcp:write) is refused by the ROLE floor (OCP-7) — it holds the
 *      write scope, but its role is granted none of the action permissions;
 *   4. THE SPLIT (ADR 0043): an ON-CALL responder MAY declare an incident but is REFUSED a deploy
 *      gate — the per-action distinction the single generic `handle_request` could never express;
 *   5. an ANONYMOUS agent can't even connect (401);
 *   6. with ANTHROPIC_API_KEY set, Claude is handed the SAME advertised tools and runs the incident
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

/**
 * Call a NAMED domain tool through the MCP client → its structured result.
 *
 * The domain tools return JSON objects, surfaced as `structuredContent` (MCP 2025-06-18); fall back
 * to parsing the text envelope for an older server.
 */
async function callDomain(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args }, CallToolResultSchema);

  return (
    result.structuredContent ??
    JSON.parse((result.content as { text: string }[])[0]?.text ?? "null")
  );
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
 * deploys, where later steps observe the effects of the earlier writes, all through the domain tools.
 */
async function scriptedIncidentResponse(sre: Client): Promise<void> {
  console.log("\n── SRE runs a multi-step incident response ────────────────────");

  // 1. Survey the fleet (read).
  const services = (await callDomain(sre, "list_services")) as { services: Service[] };
  console.log("  fleet:");
  for (const s of services.services) {
    console.log(`     • ${s.name.padEnd(12)} [${s.tier}] ${s.health}`);
  }

  // 2. A naïve deploy to a HEALTHY service ships (read the reason — the gate is real).
  const clean = (await callDomain(sre, "gate_deploy", {
    service: "checkout",
    version: "2.4.0",
  })) as { deploy: Deploy };
  console.log(`\n  deploy checkout@2.4.0 → ${clean.deploy.status} (${clean.deploy.reason})`);

  // 3. Declare a sev1 against checkout (write) — this is what freezes the next deploy.
  const declared = (await callDomain(sre, "declare_incident", {
    title: "Checkout 500s on card capture",
    severity: "sev1",
    services: ["checkout", "billing"],
  })) as { incident: Incident };
  console.log(
    `\n  🚨 declared INC-${declared.incident.id}: "${declared.incident.title}" ` +
      `(${declared.incident.severity}, services: ${declared.incident.services.join(", ")})`,
  );

  // 4. The SAME deploy is now FROZEN — caused by step 3's write, not a script.
  const frozen = (await callDomain(sre, "gate_deploy", {
    service: "checkout",
    version: "2.4.1",
  })) as { deploy: Deploy };
  console.log(
    `  deploy checkout@2.4.1 → ${frozen.deploy.status.toUpperCase()} (${frozen.deploy.reason})`,
  );

  // 5. The checkout service now reads degraded/down (the incident propagated to health).
  const afterDeclare = (await callDomain(sre, "list_services")) as { services: Service[] };
  const checkout = afterDeclare.services.find((s) => s.id === "checkout");
  console.log(`  checkout health is now: ${checkout?.health}`);

  // 6. Post mitigation, then resolve the incident (write, with a status transition).
  await callDomain(sre, "annotate_incident", {
    id: declared.incident.id,
    note: "rolled back card-capture flag; error rate falling",
    status: "mitigated",
  });
  const resolved = (await callDomain(sre, "annotate_incident", {
    id: declared.incident.id,
    note: "error rate at baseline for 15m — resolving",
    status: "resolved",
  })) as { incident: Incident };
  console.log(`\n  📝 INC-${declared.incident.id} → ${resolved.incident.status}`);

  // 7. With the incident resolved, the deploy is CLEARED — the chain's payoff.
  const cleared = (await callDomain(sre, "gate_deploy", {
    service: "checkout",
    version: "2.4.1",
  })) as { deploy: Deploy };
  console.log(`  deploy checkout@2.4.1 → ${cleared.deploy.status} (${cleared.deploy.reason})`);

  console.log("\n  deploy log:");
  const deploys = (await callDomain(sre, "list_deploys")) as { deploys: Deploy[] };
  for (const d of deploys.deploys) {
    console.log(`     • #${d.id} ${d.service}@${d.version} — ${d.status}`);
  }
}

/**
 * The governance proof (ADR 0043): a viewer is refused by the SCOPE ceiling, an over-scoped
 * stakeholder by the ROLE floor, an on-call responder may declare but NOT gate a deploy (the split),
 * and an anonymous agent can't connect at all.
 */
async function governanceProof(
  base: string,
  oncallToken: string,
  viewerToken: string,
  stakeholderToken: string,
): Promise<void> {
  console.log("\n── GOVERNANCE ─────────────────────────────────────────────────");

  const viewer = await connect(base, viewerToken);
  await viewer.listTools(); // a read-scoped client lists fine
  try {
    await viewer.callTool({
      name: "declare_incident",
      arguments: { title: "x", severity: "sev3" },
    });
    console.log("  viewer (mcp:read) declare_incident → UNEXPECTEDLY ALLOWED");
  } catch {
    console.log("  viewer (mcp:read) declare_incident → refused by SCOPE ceiling");
  }
  await viewer.close();

  // The stakeholder holds mcp:write — it clears the scope ceiling — but its ROLE is granted none of
  // the action permissions, so the OCP-7 policy floor refuses the write the scope alone would allow.
  const stakeholder = await connect(base, stakeholderToken);
  await stakeholder.listTools();
  try {
    await stakeholder.callTool({
      name: "declare_incident",
      arguments: { title: "x", severity: "sev3" },
    });
    console.log("  stakeholder (mcp:write) declare_incident → UNEXPECTEDLY ALLOWED");
  } catch {
    console.log(
      "  stakeholder (mcp:write) declare_incident → refused by ROLE floor (needs incident:declare)",
    );
  }
  await stakeholder.close();

  // THE SPLIT (ADR 0043): oncall MAY declare an incident but is REFUSED a deploy gate — the exact
  // per-action distinction that was unenforceable under the single generic handle_request.
  const oncall = await connect(base, oncallToken);
  try {
    await oncall.callTool({
      name: "declare_incident",
      arguments: { title: "oncall paged: search degraded", severity: "sev2", services: ["search"] },
    });
    console.log("  oncall declare_incident → ALLOWED (floor grants incident:declare)");
  } catch {
    console.log("  oncall declare_incident → UNEXPECTEDLY REFUSED");
  }
  try {
    await oncall.callTool({
      name: "gate_deploy",
      arguments: { service: "search", version: "9.9.9" },
    });
    console.log("  oncall gate_deploy → UNEXPECTEDLY ALLOWED");
  } catch {
    console.log("  oncall gate_deploy → refused by ROLE floor (needs deploy:gate)");
  }
  await oncall.close();

  try {
    await connect(base, undefined);
    console.log("  anonymous connect → UNEXPECTEDLY ALLOWED");
  } catch {
    console.log("  anonymous connect → refused (401)");
  }
}

/** Hand Claude the tools the MCP server actually ADVERTISES — the real, governed domain tools. */
async function claudeTools(sre: Client): Promise<Anthropic.Tool[]> {
  const { tools } = await sre.listTools();

  return tools.map((tool) => {
    const claudeTool: Anthropic.Tool = {
      name: tool.name,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    };

    // `exactOptionalPropertyTypes`: carry `description` only when the advertised tool has one.
    if (tool.description !== undefined) claudeTool.description = tool.description;

    return claudeTool;
  });
}

/** The Claude-driven finale: hand the agent the advertised tools and a goal, let it run the response. */
async function claudeIncidentResponse(sre: Client): Promise<void> {
  const model = process.env.OPS_AGENT_MODEL ?? "claude-sonnet-4-6";
  console.log(`\n── CLAUDE runs the incident response (${model}) ───────────────`);

  const anthropic = new Anthropic();
  const tools = await claudeTools(sre);
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
      if (block.type === "text" && block.text.trim() !== "")
        console.log(`  🤖 ${block.text.trim()}`);
    }

    const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) break;

    messages.push({ role: "assistant", content: resp.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      console.log(`     ↳ ${tu.name}(${JSON.stringify(tu.input)})`);
      const out = await callDomain(sre, tu.name, tu.input as Record<string, unknown>);
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
  const oncallToken = await getAccessToken(issuerUrl, "oncall");
  const viewerToken = await getAccessToken(issuerUrl, "viewer");
  const stakeholderToken = await getAccessToken(issuerUrl, "stakeholder");

  // 3. The SRE agent runs the incident-response chain across all three domains.
  const sre = await connect(base, sreToken);
  const { tools } = await sre.listTools();
  console.log(`SRE connected — ${tools.length} tools available`);
  await scriptedIncidentResponse(sre);

  // 4. Governance: viewer refused by scope, stakeholder by role, oncall split, anon refused (OCP-7 + ADR 0043).
  await governanceProof(base, oncallToken, viewerToken, stakeholderToken);

  // 5. Optional: let Claude drive the same tools autonomously.
  if (process.env.ANTHROPIC_API_KEY) {
    await claudeIncidentResponse(sre);
  } else {
    console.log(
      "\n(set ANTHROPIC_API_KEY to watch Claude run the incident response through these tools)",
    );
  }

  await sre.close();
  await rsServer.close();
  idpServer.close();
  close();
}

await main();
