// @vitest-environment jsdom

/**
 * The auth island, end to end, in a browser-like environment — the `.page` path.
 *
 * It proves the whole auth-aware-static loop without a server: render the `/`
 * page the way the static build does (the Account island ships as its signed-out
 * fallback plus a co-located mount script carrying a `bind` for its session
 * source), drop that document's body into the page, then hydrate — and watch the
 * framework resolve the session and rewrite the island per-user. There is no
 * client `fetch`-in-effect (ADR 0010): the data arrives either from the
 * parse-time primer promise (`window.__voloData`) or, as the fallback, a fetch of
 * the source's route — both stubbed here, so this is deterministic.
 */

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Registry } from "@volo/ui";
import { hydrateDocumentIslands } from "@volo/ui/client";
import { volo } from "@volo/web";

import { AccountIsland } from "../src/ui/account-island";
import { sessionSource } from "../src/session-source";
import type { SessionUser } from "../src/session-source";

// The same declaration the browser entry (client.tsx) registers.
const registry = new Registry().defineClient(AccountIsland.island);

/**
 * Render an estate-shaped `/` page the way the STATIC build does, and install its
 * body into the test document. `static: true` means no render-time resolver, so
 * the Account island ships its fallback + a session `bind` for the client to
 * resolve — exactly the prerendered, cacheable marketing page.
 */
async function installStaticPage(): Promise<void> {
  const app = volo()
    .client("/client.js")
    // The build-time loader value is irrelevant on a static page (no resolver runs).
    .data(sessionSource, () => null)
    .page("/", { static: true, component: () => <AccountIsland /> });

  const response = await app.handle("GET", "/");

  // React streams the document; drain it, then lift its <body> into the test DOM.
  const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();

  let html = "";
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    html += decoder.decode(read.value, { stream: true });
  }
  html += decoder.decode();

  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.body.innerHTML = parsed.body.innerHTML;
}

/** Drain the bind resolution + re-render. The bind is async, so the island defers then mounts. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(() => {
  document.body.innerHTML = "";
  delete window.__voloData;
  vi.unstubAllGlobals();
});

describe("the Account island", () => {
  it("emits the session bind (not a baked value) and a signed-out fallback at build", async () => {
    await installStaticPage();

    // The prerendered shell knows nobody — it shows the signed-out CTA…
    expect(document.body.textContent).toContain("Sign in");
    expect(document.body.textContent).not.toContain("Hi,");

    // …and the co-located mount script carries the unresolved session bind for the
    // client to resolve (via the parse-time primer or its fallback fetch).
    const mount = document.querySelector("[data-volo-island-mount]");
    expect(mount).not.toBeNull();

    const parsed = JSON.parse(mount?.textContent ?? "{}") as {
      bind?: Record<string, unknown>;
    };
    expect(parsed.bind).toEqual({
      session: { source: "session", href: "/__volo/data/session" },
    });
  });

  it("hydrates to a per-user greeting from the primed session promise", async () => {
    const user: SessionUser = { id: "jade", name: "Jade Mills" };
    // The primer (dataPrimerScript) already kicked the fetch before any JS ran.
    window.__voloData = { session: Promise.resolve(user) };

    await installStaticPage();

    act(() => {
      hydrateDocumentIslands(registry);
    });
    await settle();

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

    await installStaticPage();

    act(() => {
      hydrateDocumentIslands(registry);
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledWith("/__volo/data/session", { credentials: "same-origin" });
    expect(document.body.textContent).toContain("Hi, Ada");
  });

  it("stays signed-out when the session resolves to null", async () => {
    window.__voloData = { session: Promise.resolve(null) };

    await installStaticPage();

    act(() => {
      hydrateDocumentIslands(registry);
    });
    await settle();

    expect(document.body.textContent).toContain("Sign in");
    expect(document.body.textContent).not.toContain("Hi,");
  });
});
