/**
 * The project's sites — two zones on one origin.
 *
 *   marketing — static, at `/`. Prerendered to files, served from a CDN.
 *   mls       — dynamic, at `/mls`. The live, authed app.
 *
 * `keel build` reads this default export to know what to prerender; the serve
 * front door reads it to know what to path-mount where.
 */

import { defineSites } from "@keel/sites";

export default defineSites([
  { name: "marketing", render: "static", basePath: "/", pages: ["/", "/about"] },
  { name: "mls", render: "dynamic", basePath: "/mls" },
]);
