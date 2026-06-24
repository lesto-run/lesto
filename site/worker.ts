/**
 * The Cloudflare Worker — the docs site's edge front door.
 *
 * The site is fully prerendered (`lesto build` writes `out/docs/`), so the Worker does
 * almost nothing. `staticAssetsWorker` (@lesto/cloudflare) owns the whole pattern:
 * serve a matching static file from the `ASSETS` binding (cached at the edge, no
 * isolate), and on a genuine miss render a hardened 404. This site supplies only
 * its own 404 page — there is no app, database, or content engine on the edge.
 */

import { staticAssetsWorker } from "@lesto/cloudflare";

import { renderNotFound } from "./src/not-found";

export default staticAssetsWorker({ notFound: renderNotFound });
