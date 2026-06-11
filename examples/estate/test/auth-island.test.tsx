// @vitest-environment jsdom

/**
 * The auth island, end to end, in a browser-like environment.
 *
 * It proves the whole auth-aware-static loop without a server: render the page
 * the way the build does (the Account island ships as its signed-out fallback
 * and a manifest `bind` for its session source), drop that HTML into the
 * document, then hydrate — and watch the framework resolve the session and
 * rewrite the island per-user. There is no client `fetch`-in-effect anymore
 * (ADR 0010): the data arrives either from the parse-time primer promise
 * (`window.__keelData`) or, as the fallback, a fetch of the source's route —
 * both stubbed here, so this is deterministic.
 */

import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { island, renderPage } from "@keel/ui";
import { hydrateIslands } from "@keel/ui/client";
import type { UiNode } from "@keel/ui";

import { registry } from "../src/registry";
import type { SessionUser } from "../src/session-source";

const ACCOUNT_ID = "$.children[0].children[0]";

const tree: UiNode = {
  type: "Page",
  children: [{ type: "SiteHeader", children: [island("Account")] }],
};

/** Render the page like the build does (fallback markup + the session bind). */
function renderIntoDocument(): ReturnType<typeof renderPage> {
  const page = renderPage(registry, tree);

  document.body.innerHTML = page.element === null ? "" : renderToStaticMarkup(page.element);

  return page;
}

/** Drain the bind resolution + re-render. The bind is async, so the island defers then mounts. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(() => {
  document.body.innerHTML = "";
  delete window.__keelData;
  vi.unstubAllGlobals();
});

describe("the Account island", () => {
  it("emits the session bind (not a baked value) and a signed-out fallback at build", () => {
    const page = renderIntoDocument();

    // The prerendered shell knows nobody — it shows the signed-out CTA…
    expect(document.body.textContent).toContain("Sign in");
    expect(document.body.textContent).not.toContain("Hi,");

    // …and the manifest carries the unresolved session bind for the client to
    // resolve (via the parse-time primer or its fallback fetch).
    expect(page.islands[0]?.bind).toEqual({
      session: { source: "session", href: "/__keel/data/session" },
    });
  });

  it("hydrates to a per-user greeting from the primed session promise", async () => {
    const user: SessionUser = { id: "jade", name: "Jade Mills" };
    // The primer (dataPrimerScript) already kicked the fetch before any JS ran.
    window.__keelData = { session: Promise.resolve(user) };

    const page = renderIntoDocument();

    let result!: ReturnType<typeof hydrateIslands>;
    act(() => {
      result = hydrateIslands(registry, page.islands);
    });

    // Bound island → deferred until its data resolves, then mounted.
    expect(result.deferred).toEqual([ACCOUNT_ID]);

    await settle();

    expect(result.mounted).toEqual([ACCOUNT_ID]);
    expect(document.body.textContent).toContain("Hi, Jade Mills");
  });

  it("falls back to fetching the source route when nothing primed it", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: "ada", name: "Ada" }),
      } as Response),
    );
    vi.stubGlobal("fetch", fetchMock);

    const page = renderIntoDocument();

    act(() => {
      hydrateIslands(registry, page.islands);
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledWith("/__keel/data/session", { credentials: "same-origin" });
    expect(document.body.textContent).toContain("Hi, Ada");
  });

  it("stays signed-out when the session resolves to null", async () => {
    window.__keelData = { session: Promise.resolve(null) };

    const page = renderIntoDocument();

    act(() => {
      hydrateIslands(registry, page.islands);
    });
    await settle();

    expect(document.body.textContent).toContain("Sign in");
    expect(document.body.textContent).not.toContain("Hi,");
  });
});
