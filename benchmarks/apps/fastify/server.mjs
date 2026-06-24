/**
 * Fastify benchmark app (Node). Serves the workload contract in
 * `../../workloads.md`. Run: `PORT=3102 node server.mjs`.
 */
import Fastify from "fastify";

import { jsonObject, plaintextBody, ssrBody } from "../_contract.mjs";

const PORT = Number(process.env.PORT ?? 3102);
const SSR_BODY = ssrBody();

const app = Fastify({ logger: false });
app.get("/plaintext", (_req, reply) => reply.type("text/plain").send(plaintextBody));
app.get("/json", (_req, reply) => reply.send(jsonObject));
app.get("/ssr", (_req, reply) => reply.type("text/html").send(SSR_BODY));

app.listen({ port: PORT, host: "127.0.0.1" }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`fastify bench app listening on ${address}`);
});
