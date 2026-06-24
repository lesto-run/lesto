/**
 * Express benchmark app (Node). Serves the workload contract in
 * `../../workloads.md`. Run: `PORT=3103 node server.mjs`.
 */
import express from "express";

import {
  jsonObject,
  plaintextBody,
  realisticBody,
  simulateDbLatency,
  ssrBody,
} from "../_contract.mjs";

const PORT = Number(process.env.PORT ?? 3103);
const SSR_BODY = ssrBody();

const app = express();
// Compact JSON (no pretty-printing) so the body matches the contract byte-for-byte.
app.set("json spaces", 0);
app.get("/plaintext", (_req, res) => res.type("text/plain").send(plaintextBody));
app.get("/json", (_req, res) => res.json(jsonObject));
app.get("/ssr", (_req, res) => res.type("html").send(SSR_BODY));
// /realistic: re-render the catalog page per request behind a simulated DB round-trip.
app.get("/realistic", async (_req, res) => {
  await simulateDbLatency();
  res.type("html").send(realisticBody());
});

app.listen(PORT, "127.0.0.1", () =>
  console.log(`express bench app listening on http://127.0.0.1:${PORT}`),
);
