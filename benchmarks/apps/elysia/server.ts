/**
 * Elysia benchmark app (Bun-native). Serves the workload contract in
 * `../../workloads.md`. Run: `PORT=3104 bun run server.ts`.
 */
import { Elysia } from "elysia";

import { jsonObject, plaintextBody, ssrBody } from "../_contract.mjs";

const PORT = Number(process.env.PORT ?? 3104);
const SSR_BODY = ssrBody();

new Elysia()
  .get("/plaintext", () => plaintextBody)
  .get("/json", () => jsonObject)
  .get("/ssr", ({ set }) => {
    set.headers["content-type"] = "text/html";

    return SSR_BODY;
  })
  .listen({ port: PORT, hostname: "127.0.0.1" }, ({ port }) =>
    console.log(`elysia bench app listening on http://127.0.0.1:${port}`),
  );
