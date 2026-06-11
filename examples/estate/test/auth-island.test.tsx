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
 * Hydrate the page, then let the island's chunk, mount, fetch, and re-render
 * all settle.
 *
 * The island is lazy (per-island code-splitting, ADR 0009), so its mount waits
 * on a REAL dynamic import — under vitest that means an on-demand module
 * transform whose duration is not a fixed number of ticks. Guessing a flush
 * count races it; instead we wait for the runtime's own completion report (the
 * caller-held `mounted`/`failed` arrays it appends to), then flush once more so
 * the mounted component's effect runs its session fetch and re-renders.
 */
async function hydrateAndSettle(page: ReturnType<typeof renderPage>): Promise<void> {
  let result!: ReturnType<typeof hydrateIslands>;

  act(() => {
    result = hydrateIslands(registry, page.islands);
  });

  await act(async () => {
    for (let i = 0; i < 200 && result.mounted.length === 0 && result.failed.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });

  // The chunk landed and the island mounted — loudly, not by luck.
  expect(result.failed).toEqual([]);
  expect(result.mounted).toHaveLength(1);

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
