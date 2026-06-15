import { expect, test } from "@playwright/test";

/**
 * Island hydration, in a real browser — the one path no server-side test can
 * reach. The server ships the island's "loading…" fallback; only if `/app.js`
 * loads and `hydrateIslands` mounts the client `Probe` does the DOM become
 * "hydrated ✓". We assert both ends of that transition.
 */

test("the island ships a server fallback, then hydrates in the browser", async ({
  page,
  request,
}) => {
  // The server-sent HTML carries the island's fallback (asserted on the raw
  // bytes — hydration is too fast to observe the pre-mount DOM in the browser).
  const html = await (await request.get("/")).text();
  expect(html).toContain('data-probe="fallback"');
  expect(html).toContain("loading…");

  // In the browser, the client component has mounted and taken over.
  await page.goto("/");
  await expect(page.locator('[data-probe="hydrated"]')).toHaveText("hydrated ✓");
  await expect(page.locator('[data-probe="fallback"]')).toHaveCount(0);
});

test("the island bundle is served as JavaScript", async ({ request }) => {
  const response = await request.get("/app.js");

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/javascript");
});
