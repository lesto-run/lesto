/**
 * Hono benchmark app (Node, via @hono/node-server). Serves the workload contract
 * in `../../workloads.md`. Run: `PORT=3101 node server.mjs`.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";

import {
  jsonObject,
  plaintextBody,
  realisticBody,
  simulateDbLatency,
  ssrBody,
} from "../_contract.mjs";

const PORT = Number(process.env.PORT ?? 3101);
const SSR_BODY = ssrBody();

const app = new Hono();
app.get("/plaintext", (c) => c.text(plaintextBody));
app.get("/json", (c) => c.json(jsonObject));
app.get("/ssr", (c) => c.html(SSR_BODY));
// /realistic: re-render the catalog page per request behind a simulated DB round-trip.
app.get("/realistic", async (c) => {
  await simulateDbLatency();

  return c.html(realisticBody());
});

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, ({ port }) =>
  console.log(`hono bench app listening on http://127.0.0.1:${port}`),
);
