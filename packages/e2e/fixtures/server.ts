/**
 * The fixture server Playwright drives.
 *
 * It bundles the client entry to `app.js` (via `bun build`), renders a page with
 * an island through `@lesto/ui`'s `renderPage`, and serves both over a real
 * `@lesto/runtime` socket: `GET /` returns the island-bearing HTML, `GET /app.js`
 * returns the bundle. Nothing example-specific — just the framework's island
 * machinery on a minimal page, so the browser test exercises Lesto itself.
 *
 *   bun run fixtures/server.ts   # PORT defaults to 4180
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";

import type { UiNode } from "@lesto/ui";
import { renderPage } from "@lesto/ui/server";
import { serve } from "@lesto/runtime";

import { registry } from "./registry";

const PORT = Number(process.env["PORT"] ?? 4180);
const HERE = fileURLToPath(new URL(".", import.meta.url));

// Bundle the client entry to app.js. Done at boot so the served bundle always
// matches the current source — the same shape a project's build step produces.
const BUNDLE = join(HERE, ".out", "app.js");
execFileSync(
  "bun",
  ["build", "fixtures/client.tsx", "--outfile", "fixtures/.out/app.js", "--target", "browser"],
  {
    cwd: join(HERE, ".."),
    stdio: "inherit",
  },
);
const appJs = readFileSync(BUNDLE, "utf8");

const tree: UiNode = { type: "Page", children: [{ type: "Probe" }] };

function htmlDocument(): string {
  const page = renderPage(registry, tree);
  const body = page.element === null ? "" : renderToStaticMarkup(page.element);
  const manifest = JSON.stringify(page.islands).replaceAll("<", "\\u003c");

  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8" /><title>Lesto island fixture</title></head>',
    "<body>",
    body,
    `<script id="lesto-islands" type="application/json">${manifest}</script>`,
    '<script type="module" src="/app.js"></script>',
    "</body></html>",
  ].join("\n");
}

const dispatch = (
  _method: string,
  path: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> =>
  Promise.resolve(
    path === "/app.js"
      ? { status: 200, headers: { "content-type": "text/javascript; charset=utf-8" }, body: appJs }
      : {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: htmlDocument(),
        },
  );

const server = await serve({ handle: dispatch, migrationsApplied: [] }, { port: PORT });

console.log(`island fixture on http://127.0.0.1:${server.port}`);

const shutdown = (): void => void server.close().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
