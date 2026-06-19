/**
 * The browser entry — what `<script src="/client.js">` loads.
 *
 * It builds a registry holding the page's island declarations and calls
 * `hydrateDocumentIslands`, which scans the document for the co-located
 * `data-lesto-island-mount` scripts `defineIsland` emitted, then finds each marked
 * shell and mounts the real client component.
 *
 * This is the CANONICAL synthesized shape (ADR 0011 Increment 2): one client
 * entry that registers exactly the islands declared under `app/islands/` (one
 * `defineIsland` default-export per file) and hands them to
 * `hydrateDocumentIslands`. It is what `@lesto/assets`' `synthesizeEntry` would
 * generate from the same `app/islands/` convention — kept checked in here so the
 * source is inspectable. Bundle it to `/client.js`; until then the page degrades
 * gracefully to the island's server markup (which, being `ssr: true`, is already
 * the full board — hydration only makes the status tabs interactive).
 */

import { Registry } from "@lesto/ui";
import { hydrateDocumentIslands } from "@lesto/ui/client";

import QueueBoardIsland from "./app/islands/queue-board";

const registry = new Registry().defineClient(QueueBoardIsland.island);

hydrateDocumentIslands(registry);
