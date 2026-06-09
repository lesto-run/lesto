import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { App } from "@keel/kernel";

import { applyResponse } from "./response";
import { toKeelRequest } from "./request";

/** A running http server bound to a port, with a graceful shutdown. */
export interface Server {
  readonly port: number;

  close(): Promise<void>;
}

export interface ServeOptions {
  readonly port?: number;

  readonly host?: string;
}

/**
 * The method and path of an incoming request.
 *
 * Node types `method`/`url` as optional, yet a *server* request always carries
 * both. We still default them — defensively, and so the narrowing is honest
 * rather than a cast — and unit-test both branches with a fake message.
 */
export function requestLineOf(req: Pick<IncomingMessage, "method" | "url">): {
  method: string;
  url: string;
} {
  return {
    method: req.method ?? "GET",
    url: req.url ?? "/",
  };
}

/** Read the full request body off the socket as a UTF-8 string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => chunks.push(chunk));

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/**
 * Boot a node:http server that serves a Keel {@link App}.
 *
 * Each request is read in full, normalized into a transport-free `KeelRequest`,
 * dispatched through `app.handle`, and its response written back. The server is
 * stateless: all durable state lives in the app's database, so multiple
 * instances scale horizontally and deploys are rolling restarts.
 *
 * Resolves once the socket is listening, carrying the bound port — so a caller
 * that passed `port: 0` (the default) learns which ephemeral port it got.
 */
export function serve(app: App, options: ServeOptions = {}): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(app, req, res);
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      // listen() resolved, so address() is a bound AddressInfo, not null.
      const address = server.address() as AddressInfo;

      resolve({
        port: address.port,

        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

/** Drive one request through the app and write its response. */
async function handle(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);

  const line = requestLineOf(req);

  const request = toKeelRequest({
    method: line.method,
    url: line.url,
    headers: req.headers,
    body,
  });

  const response = await app.handle(request.method, request.path, {
    query: request.query,
    body: request.body,
  });

  applyResponse(res, response);
}
