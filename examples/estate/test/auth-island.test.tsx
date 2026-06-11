// @vitest-environment jsdom

/**
 * The auth island, end to end, in a browser-like environment.
 *
 * It proves the whole auth-aware-static loop without a server: render the page
 * the way the build does (the Account island ships as its signed-out fallback),
 * drop that HTML into the document, then hydrate — and watch the island resolve
 * the same-origin session and rewrite itself per-user. The session fetch is
 * stubbed, so this is deterministic.
 */

import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { island, renderPage } from "@keel/ui";
import { hydrateIslands } from "@keel/ui/client";
import type { UiNode } from "@keel/ui";

import { registry } from "../src/registry";
import type { User } from "../src/session-client";

const tree: UiNode = {
  type: "Page",
  children: [{ type: "SiteHeader", children: [island("Account")] }],
};

/** Stub `fetch` to answer the session endpoint with `user` (or a 401 when null). */
function stubSession(user: User | null): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: user !== null, json: () => Promise.resolve({ user }) })),
  );
}

/** Render the page like the build does and put its HTML in the document. */
function renderIntoDocument(): ReturnType<typeof renderPage> {
  const page = renderPage(registry, tree);

  document.body.innerHTML = page.element === null ? "" : renderToStaticMarkup(page.element);

  return page;
}

/**
 * Hydrate the page and let the island's mount, session fetch, and re-render
 * settle.
 *
 * Account is an EAGER island (registry.tsx: `component:`, not `load:`), so it
 * mounts synchronously the instant `hydrateIslands` runs. The one macrotask
 * flush is for what happens *after* the mount — its on-mount `/mls/api/session`
 * fetch and the per-user re-render that follows. (A microtask-only flush would
 * starve the event loop and never resolve the fetch chain.)
 */
async function hydrateAndSettle(page: ReturnType<typeof renderPage>): Promise<void> {
  const result = await act(async () => hydrateIslands(registry, page.islands));

  // Mounted synchronously, by design — no chunk to wait on.
  expect(result.mounted).toEqual(["$.children[0].children[0]"]);
  expect(result.deferred).toEqual([]);

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("the Account island", () => {
  it("ships as a signed-out shell, then hydrates to a greeting for a signed-in user", async () => {
    stubSession({ id: "jade", name: "Jade Mills" });

    const page = renderIntoDocument();

    // The prerendered shell knows nobody — it shows the signed-out CTA.
    expect(document.body.textContent).toContain("Sign in");
    expect(document.body.textContent).not.toContain("Hi,");

    await hydrateAndSettle(page);

    // Hydration resolved the session and rewrote the island, per-user.
    expect(document.body.textContent).toContain("Hi, Jade Mills");
  });

  it("stays signed-out when no session is present", async () => {
    stubSession(null);

    const page = renderIntoDocument();

    await hydrateAndSettle(page);

    expect(document.body.textContent).toContain("Sign in");
    expect(document.body.textContent).not.toContain("Hi,");
  });
});
