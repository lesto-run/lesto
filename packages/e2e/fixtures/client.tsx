/**
 * The browser entry — bundled to `/app.js` and loaded by the fixture page.
 *
 * Reads the island manifest the server embedded and hands it to
 * `hydrateIslands`, which mounts the real `Probe` into its server-rendered
 * shell. This is the exact shape a real Volo app's client entry takes.
 */

import { hydrateIslands } from "@volo/ui/client";
import type { IslandMount } from "@volo/ui";

import { registry } from "./registry";

const script = document.getElementById("volo-islands");
const manifest = (script?.textContent ? JSON.parse(script.textContent) : []) as IslandMount[];

hydrateIslands(registry, manifest);
