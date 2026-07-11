// Parse wrangler's pretty-printed (multi-line) tail output — a stream of
// concatenated JSON objects — into per-request {path, cpuTime, wallTime,
// outcome}. Brace-depth scan that respects strings/escapes.
import { readFileSync } from "node:fs";

const raw = readFileSync(process.argv[2], "utf8");
const objs = [];
let depth = 0,
  start = -1,
  inStr = false,
  esc = false;
for (let i = 0; i < raw.length; i++) {
  const c = raw[i];
  if (inStr) {
    if (esc) esc = false;
    else if (c === "\\") esc = true;
    else if (c === '"') inStr = false;
    continue;
  }
  if (c === '"') inStr = true;
  else if (c === "{") {
    if (depth === 0) start = i;
    depth++;
  } else if (c === "}") {
    depth--;
    if (depth === 0 && start >= 0) {
      try {
        objs.push(JSON.parse(raw.slice(start, i + 1)));
      } catch {}
      start = -1;
    }
  }
}

for (const e of objs) {
  const url = e.event?.request?.url;
  if (!url) continue;
  const u = new URL(url);
  console.log(
    JSON.stringify({
      path: u.pathname + u.search,
      cpuMs: e.cpuTime,
      wallMs: e.wallTime,
      outcome: e.outcome,
      colo: e.event?.request?.cf?.colo,
    }),
  );
}
