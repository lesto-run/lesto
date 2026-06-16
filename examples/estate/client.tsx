/**
 * The browser entry — what `<script src="/client.js">` loads.
 *
 * It builds a registry holding the page's island declarations and calls
 * `hydrateDocumentIslands`, which scans the document for the co-located
 * `data-keel-island-mount` scripts `defineIsland` emitted, then finds each marked
 * shell and mounts the real client component (here, `Account`, which resolves the
 * same-origin session). Bundle this to `/client.js` (estate's `build-client.ts`,
 * or `@keel/assets`); until then the pages degrade gracefully to their fallbacks.
 */

import { Registry } from "@keel/ui";
import { hydrateDocumentIslands } from "@keel/ui/client";

import { AccountIsland } from "./src/ui/account-island";

// The island's declaration (carried on `.island`) is what the client registers,
// so the browser mounts the very component the server reserved a slot for.
const registry = new Registry().defineClient(AccountIsland.island);

hydrateDocumentIslands(registry);
