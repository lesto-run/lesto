/**
 * The whole schema-driven form journey, in-process, in one run.
 *
 *   bun run examples/forms/run.ts
 *
 * It boots the app (no database — forms are render + validate), then drives the
 * journey through the real HTTP routes: render the form, submit an INVALID body
 * and watch the per-field errors come back, submit a VALID one and get the
 * confirmation, then read the accepted signups.
 */

import { buildApp } from "./src/app";

/** Pull the `<li data-error>` messages out of a re-rendered form page. */
function errorsIn(html: string): string[] {
  return [...html.matchAll(/data-error="[^"]*">([^<]*)</g)].map((m) => m[1] ?? "");
}

async function main(): Promise<void> {
  const { app } = buildApp();

  // 1. Render the form.
  const rendered = await app.handle("GET", "/signup");
  const form = rendered.body as string;
  console.log(`GET /signup -> ${rendered.status}`);
  console.log(
    `  has <form>: ${form.includes("<form")}, has <select>: ${form.includes("<select")}\n`,
  );

  // 2. Submit an invalid body — missing email, bad plan, unchecked terms.
  const invalid = await app.handle("POST", "/signup", {
    body: { plan: "enterprise" },
  });
  console.log(`POST /signup (invalid) -> ${invalid.status}`);
  console.log(`  errors: ${JSON.stringify(errorsIn(invalid.body as string))}\n`);

  // 3. Submit a valid body.
  const valid = await app.handle("POST", "/signup", {
    body: { email: "ada@example.com", age: "36", plan: "pro", terms: "on" },
  });
  console.log(`POST /signup (valid) -> ${valid.status}`);
  console.log(`  ${(valid.body as string).includes("Welcome") ? "confirmation shown" : "??"}\n`);

  // 4. Read the accepted signups.
  const signups = await app.handle("GET", "/signups");
  console.log(`GET /signups -> ${signups.body}`);
}

await main();
