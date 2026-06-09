/**
 * The browser entry — what `<script src="/client.js">` loads.
 *
 * It reads the island manifest the server embedded and hands it to
 * `hydrateIslands`, which finds each marked shell and mounts the real client
 * component (here, `Account`, which resolves the same-origin session). Bundle
 * this with any bundler (e.g. Vite) to produce the `/client.js` the document
 * references; until then the pages degrade gracefully to their fallbacks.
 */

import { hydrateIslands } from "@keel/ui/client";
import type { IslandMount } from "@keel/ui";

import { registry } from "./src/registry";

const script = document.getElementById("keel-islands");
const manifest = (script?.textContent ? JSON.parse(script.textContent) : []) as IslandMount[];

hydrateIslands(registry, manifest);
