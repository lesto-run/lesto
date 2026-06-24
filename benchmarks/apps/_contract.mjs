/**
 * The single source of truth for the workload response bodies (see
 * `../workloads.md`). Every Node/Bun app imports these so the bytes are defined
 * once — if an app's framework renderer emits anything else, the parity check
 * fails and the run is void.
 */

/** The exact `/plaintext` body. */
export const plaintextBody = "Hello, World!";

/** The exact `/json` body (compact, no whitespace). */
export const jsonObject = { message: "Hello, World!" };
export const jsonBody = JSON.stringify(jsonObject);

/** How many rows the SSR workload renders. */
export const SSR_ROWS = 50;

/** The inner row list — the part a framework's SSR renderer must produce. */
export function ssrRows(rows = SSR_ROWS) {
  let out = "";
  for (let i = 0; i < rows; i += 1) {
    out += `<div class="row"><span class="cell">item ${i}</span></div>`;
  }

  return out;
}

/** Wrap rendered body markup in the minimal document shell the contract requires. */
export function htmlDocument(body) {
  return `<!doctype html><html><head><title>Bench</title></head><body>${body}</body></html>`;
}

/** The exact, full `/ssr` body. */
export function ssrBody(rows = SSR_ROWS) {
  return htmlDocument(`<div class="box">${ssrRows(rows)}</div>`);
}
