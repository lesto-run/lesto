/**
 * Elysia benchmark app (Bun-native). Serves the workload contract in
 * `../../workloads.md`. Run: `PORT=3104 bun run server.ts`.
 */
import { Elysia } from "elysia";

import {
  jsonObject,
  plaintextBody,
  realisticBody,
  simulateDbLatency,
  ssrBody,
} from "../_contract.mjs";

const PORT = Number(process.env.PORT ?? 3104);
const SSR_BODY = ssrBody();

new Elysia()
  .get("/plaintext", () => plaintextBody)
  .get("/json", () => jsonObject)
  .get("/ssr", ({ set }) => {
    set.headers["content-type"] = "text/html";

    return SSR_BODY;
  })
  // /realistic: re-render the catalog page per request behind a simulated DB round-trip.
  .get("/realistic", async ({ set }) => {
    await simulateDbLatency();
    set.headers["content-type"] = "text/html";

    return realisticBody();
  })
  .listen({ port: PORT, hostname: "127.0.0.1" }, ({ port }) =>
    console.log(`elysia bench app listening on http://127.0.0.1:${port}`),
  );
