// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { aiOverlayClientScript } from "../src/ai-overlay";

/**
 * The in-preview AI overlay CLIENT (ADR 0033 Inc 1), exercised as the REAL injected code.
 *
 * `ai-overlay.ts` builds a `<script>` string the bin injects verbatim; here we run that
 * exact string against a jsdom document with a stub `fetch`, then drive its Cmd-K toggle +
 * chat submit and assert the DOM it paints. The script's free `document`/`addEventListener`/
 * `fetch` are passed as `new Function` params, so the overlay lands in the real document we
 * query and the network is a controlled stub. We execute the shipped artifact, never a
 * re-implementation — a typo in the overlay would fail here.
 */

const OVERLAY_ID = "__lesto_ai_overlay__";

function panel(): HTMLElement | null {
  return document.getElementById(OVERLAY_ID);
}

/**
 * Eval the injected client with the given options + stub fetch. The overlay's `keydown`
 * listener is bound to a FRESH per-mount `EventTarget` (not the shared window), so tests
 * don't accumulate listeners across the file — a later Cmd-K can't wake an earlier mount.
 * The returned target is where {@link keydown} dispatches the toggle chord.
 */
function mount(
  options: { endpoint?: string; token?: string },
  fetchImpl: typeof fetch,
): EventTarget {
  const target = new EventTarget();
  const exec = new Function(
    "document",
    "addEventListener",
    "fetch",
    aiOverlayClientScript(options),
  );

  exec(document, target.addEventListener.bind(target), fetchImpl);

  return target;
}

/** Dispatch a keydown on the mount's own target (where the overlay registered its toggle). */
function keydown(
  target: EventTarget,
  key: string,
  modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {},
): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, ...modifiers }));
}

/** Submit the chat form with a prompt, then flush the async send. */
async function ask(prompt: string): Promise<void> {
  const input = panel()?.querySelector("input");
  const form = panel()?.querySelector("form");

  if (!input || !form) throw new Error("the chat form is not present");

  input.value = prompt;
  form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

  // Let the send()'s fetch + two awaited microtasks settle before asserting.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A stub fetch that resolves one JSON body with the given ok/status. */
function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}): typeof fetch {
  return vi.fn(() =>
    Promise.resolve({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: () => Promise.resolve(body),
    }),
  ) as unknown as typeof fetch;
}

describe("in-preview AI overlay client", () => {
  afterEach(() => {
    panel()?.remove();
  });

  it("toggles the chat panel open on Cmd-K and closed on a second Cmd-K", () => {
    const target = mount({ endpoint: "/__lesto_dev_ai" }, stubFetch({ reply: "" }));

    // Nothing is painted at eval — only the keydown listener was registered.
    expect(panel()).toBeNull();

    keydown(target, "k", { metaKey: true });
    expect(panel()).not.toBeNull();
    expect(panel()?.style.display).toBe("flex");

    keydown(target, "k", { metaKey: true });
    expect(panel()?.style.display).toBe("none");
  });

  it("also toggles on Ctrl-K (the non-mac chord)", () => {
    const target = mount({ endpoint: "/x" }, stubFetch({ reply: "" }));

    keydown(target, "k", { ctrlKey: true });

    expect(panel()?.style.display).toBe("flex");
  });

  it("ignores a modified non-K key and an unmodified K (only the Cmd/Ctrl-K chord toggles)", () => {
    const target = mount({ endpoint: "/x" }, stubFetch({ reply: "" }));

    keydown(target, "a", { metaKey: true });
    keydown(target, "k");

    // Neither is the chord, so the panel was never built.
    expect(panel()).toBeNull();
  });

  it("POSTs a prompt and renders the read-only reply as textContent", async () => {
    const fetchImpl = stubFetch({ reply: "Add a route for /posts/:id" });
    const target = mount({ endpoint: "/__lesto_dev_ai", token: "sesh-token" }, fetchImpl);

    keydown(target, "k", { metaKey: true });
    await ask("why is /posts/1 a 404?");

    const text = panel()?.textContent ?? "";

    // Both turns are shown: the user's prompt and the server's reply.
    expect(text).toContain("why is /posts/1 a 404?");
    expect(text).toContain("Add a route for /posts/:id");

    // It POSTed the prompt as JSON to the configured relative endpoint, presenting the per-session
    // dev token as the `x-lesto-dev-token` header (the server constant-time compares it).
    expect(fetchImpl).toHaveBeenCalledWith(
      "/__lesto_dev_ai",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-lesto-dev-token": "sesh-token" }),
      }),
    );
  });

  it("renders a markup reply as inert TEXT — never injected into the DOM", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    const target = mount({ endpoint: "/x" }, stubFetch({ reply: evil }));

    keydown(target, "k", { metaKey: true });
    await ask("break out");

    expect(panel()?.textContent).toContain(evil);
    expect(panel()?.querySelector("img")).toBeNull();
  });

  it("shows a request-failed line when the endpoint answers non-2xx", async () => {
    const target = mount({ endpoint: "/x" }, stubFetch({}, { ok: false, status: 503 }));

    keydown(target, "k", { metaKey: true });
    await ask("hello");

    expect(panel()?.textContent).toContain("request failed (503)");
  });

  it("shows a request-failed line when the fetch itself throws", async () => {
    const throwing = vi.fn(() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const target = mount({ endpoint: "/x" }, throwing);

    keydown(target, "k", { metaKey: true });
    await ask("hello");

    expect(panel()?.textContent).toContain("request failed");
  });

  it("ignores an empty/whitespace prompt (no turn, no fetch)", () => {
    const fetchImpl = stubFetch({ reply: "" });
    const target = mount({ endpoint: "/x" }, fetchImpl);

    keydown(target, "k", { metaKey: true });
    const input = panel()?.querySelector("input");
    const form = panel()?.querySelector("form");
    input!.value = "   ";
    form!.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("paints the fail-loud not-available state (no input) when no endpoint is configured", () => {
    const target = mount({}, stubFetch({ reply: "" }));

    keydown(target, "k", { metaKey: true });

    expect(panel()?.textContent).toContain("dev MCP server not available");
    // Inspect-only: with no endpoint there is no chat input to submit.
    expect(panel()?.querySelector("input")).toBeNull();
    expect(panel()?.querySelector("form")).toBeNull();
  });

  it("renders every dynamic field via textContent — the shipped script names no innerHTML", () => {
    // Assert the GENERATED client (both code paths — with and without an endpoint) is
    // innerHTML-free: the injected code that actually runs in the browser can only ever
    // write via textContent, so a markup reply/error can never inject into the page.
    expect(aiOverlayClientScript({ endpoint: "/x" })).not.toContain("innerHTML");
    expect(aiOverlayClientScript({})).not.toContain("innerHTML");
  });
});
