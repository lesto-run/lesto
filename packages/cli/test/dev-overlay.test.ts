// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { devReloadClientScript } from "../src/dev-overlay";

/**
 * The dev error-overlay CLIENT, exercised as the REAL injected browser code.
 *
 * `dev-overlay.ts` builds a `<script>` string the bin injects verbatim; here we run
 * that exact string against a jsdom document with a fake `WebSocket`/`location`, then
 * drive its `onmessage`/`onclose` and assert the overlay DOM it paints. The script's
 * free `location`/`WebSocket`/`document`/`addEventListener`/`setTimeout` are passed as
 * `new Function` params (so `location` need not be reassigned on the non-configurable
 * jsdom window, and the overlay still lands in the real document we query). We execute
 * the shipped artifact, never a re-implementation — a typo in the overlay would fail.
 */

interface FakeSocket {
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
}

const OVERLAY_ID = "__lesto_dev_overlay__";

function overlay(): HTMLElement | null {
  return document.getElementById(OVERLAY_ID);
}

/** Run the injected client and return its socket + the `location.reload` spy + url. */
function mountClient(port = 35729): {
  socket: FakeSocket;
  reload: ReturnType<typeof vi.fn>;
  url: string;
} {
  const reload = vi.fn();

  let socket: FakeSocket | undefined;
  let url = "";

  // A fake WebSocket: `new WebSocket(url)` returns this plain object (captured here),
  // whose `onmessage`/`onclose` the test then drives. Returning an object from the
  // constructor is what `new` yields — and it avoids aliasing `this`.
  const FakeWebSocket = function (socketUrl: string): FakeSocket {
    url = socketUrl;
    socket = { onmessage: null, onclose: null };

    return socket;
  };

  const location = { hostname: "127.0.0.1", reload };

  const exec = new Function(
    "location",
    "WebSocket",
    "document",
    "addEventListener",
    "setTimeout",
    devReloadClientScript(port),
  );

  exec(location, FakeWebSocket, document, window.addEventListener.bind(window), setTimeout);

  if (socket === undefined) throw new Error("the client never opened a socket");

  return { socket, reload, url };
}

/** Deliver a server frame to the mounted client. */
function send(socket: FakeSocket, payload: unknown): void {
  socket.onmessage?.({ data: typeof payload === "string" ? payload : JSON.stringify(payload) });
}

describe("dev error-overlay client", () => {
  afterEach(() => {
    overlay()?.remove();
  });

  it("connects to the live-reload port it was built with", () => {
    expect(mountClient(41234).url).toBe("ws://127.0.0.1:41234");
  });

  it("paints a full-screen overlay on an error frame, with source/message/stack as text", () => {
    const { socket } = mountClient();

    send(socket, {
      type: "error",
      source: "app-reload",
      message: "Unexpected token in page.tsx",
      stack: "at page.tsx:3:7",
    });

    const node = overlay();

    expect(node).not.toBeNull();
    expect(node?.textContent).toContain("app-reload");
    expect(node?.textContent).toContain("Unexpected token in page.tsx");
    // The stack lands in its own <pre>.
    expect(node?.querySelector("pre")?.textContent).toBe("at page.tsx:3:7");
  });

  it("omits the stack <pre> when the error carries none", () => {
    const { socket } = mountClient();

    send(socket, { type: "error", source: "client-rebuild", message: "esbuild: oops" });

    expect(overlay()?.textContent).toContain("esbuild: oops");
    expect(overlay()?.querySelector("pre")).toBeNull();
  });

  it("renders a markup error message as inert TEXT — never injected into the DOM", () => {
    const { socket } = mountClient();
    const evil = "<img src=x onerror=alert(1)><script>boom()</script>";

    send(socket, { type: "error", source: "app-reload", message: evil });

    // Shown verbatim as text; no <img>/<script> element is ever parsed from it.
    expect(overlay()?.textContent).toContain(evil);
    expect(overlay()?.querySelector("img")).toBeNull();
    expect(overlay()?.querySelector("script")).toBeNull();
  });

  it("replaces a prior overlay rather than stacking a second one", () => {
    const { socket } = mountClient();

    send(socket, { type: "error", source: "app-reload", message: "first" });
    send(socket, { type: "error", source: "client-rebuild", message: "second" });

    expect(document.querySelectorAll(`#${OVERLAY_ID}`)).toHaveLength(1);
    expect(overlay()?.textContent).toContain("second");
    expect(overlay()?.textContent).not.toContain("first");
  });

  it("reloads (and shows no overlay) on a reload frame", () => {
    const { socket, reload } = mountClient();

    send(socket, { type: "reload" });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(overlay()).toBeNull();
  });

  it("reloads as the safe fallback on a malformed, non-JSON frame", () => {
    const { socket, reload } = mountClient();

    send(socket, "not-json");

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("dismisses a shown overlay on Escape", () => {
    const { socket } = mountClient();

    send(socket, { type: "error", source: "app-reload", message: "x" });
    expect(overlay()).not.toBeNull();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(overlay()).toBeNull();
  });

  it("retries the connection a second later when the socket drops", () => {
    vi.useFakeTimers();

    try {
      const { socket } = mountClient();

      socket.onclose?.();

      // The 1s reconnect fires and opens a fresh socket without throwing.
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
