/**
 * The browser entry — bundled to `/app.js` and loaded by the fixture page.
 *
 * Reads the island manifest the server embedded and hands it to
 * `hydrateIslands`, which mounts the real `Probe` into its server-rendered
 * shell. This is the exact shape a real Keel app's client entry takes.
 */

import { hydrateIslands } from "@keel/ui/client";
import type { IslandMount } from "@keel/ui";

import { registry } from "./registry";

const script = document.getElementById("keel-islands");
const manifest = (script?.textContent ? JSON.parse(script.textContent) : []) as IslandMount[];

hydrateIslands(registry, manifest);
