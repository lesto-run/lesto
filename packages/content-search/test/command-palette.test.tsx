// @vitest-environment jsdom

import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mark this as an act() environment so React flushes effects synchronously
// inside our act() wrappers (mirrors @lesto/content-components' React tests).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { CommandPalette, useCommandPalette, commandPaletteStyles } from "../src/command-palette";
import type { Tier0Index } from "../src/types";

// ---------------------------------------------------------------------------
// Live-DOM render plumbing.
// ---------------------------------------------------------------------------

let containers: Array<{ el: HTMLElement; root: Root }> = [];

function renderLive(node: ReactNode): HTMLElement {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  act(() => {
    root.render(node);
  });
  containers.push({ el, root });
  return el;
}

afterEach(() => {
  for (const { el, root } of containers) {
    act(() => root.unmount());
    el.remove();
  }
  containers = [];
  document.body.style.overflow = "";
  vi.restoreAllMocks();
});

/** Dispatch a bubbling keydown so React's root delegation + the document-level
 *  global shortcut listener both see it. Returns the event for `defaultPrevented`. */
function fireKey(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** Set a controlled <input>'s value past React's value tracker, then fire input. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// ===========================================================================
// useCommandPalette — the headless controller
// ===========================================================================

interface HarnessProps {
  initialCount?: number;
  onSelect?: (index: number) => void;
  onOpenChange?: (open: boolean) => void;
  loop?: boolean;
  openOnSlash?: boolean;
  defaultOpen?: boolean;
}

function Harness({
  initialCount = 3,
  onSelect,
  onOpenChange,
  loop,
  openOnSlash,
  defaultOpen,
}: HarnessProps): ReactNode {
  const [count, setCount] = useState(initialCount);
  const p = useCommandPalette({
    count,
    ...(onSelect && { onSelect }),
    ...(onOpenChange && { onOpenChange }),
    ...(loop !== undefined && { loop }),
    ...(openOnSlash !== undefined && { openOnSlash }),
    ...(defaultOpen !== undefined && { defaultOpen }),
  });
  return createElement(
    "div",
    null,
    createElement("input", { "data-testid": "external" }),
    createElement("button", { "data-testid": "trigger", ...p.triggerProps }, "open"),
    createElement("button", { "data-testid": "shrink", onClick: () => setCount(2) }, "shrink"),
    createElement("span", { "data-testid": "open" }, String(p.open)),
    createElement("span", { "data-testid": "active" }, String(p.active)),
    p.open
      ? createElement(
          "div",
          { "data-testid": "dialog", ...p.dialogProps },
          createElement("input", { "data-testid": "input", ...p.inputProps }),
          createElement(
            "ul",
            p.listProps,
            Array.from({ length: count }, (_unused, i) =>
              createElement(
                "li",
                { key: i, "data-testid": `opt-${i}`, ...p.getItemProps(i) },
                `item ${i}`,
              ),
            ),
          ),
        )
      : null,
  );
}

function txt(el: HTMLElement, testid: string): string {
  return el.querySelector(`[data-testid="${testid}"]`)?.textContent ?? "";
}

describe("useCommandPalette", () => {
  it("opens and closes on ⌘K, and again on a second press", () => {
    const el = renderLive(createElement(Harness, {}));
    expect(txt(el, "open")).toBe("false");

    fireKey(document, { key: "k", metaKey: true });
    expect(txt(el, "open")).toBe("true");
    expect(el.querySelector('[data-testid="dialog"]')).not.toBeNull();

    fireKey(document, { key: "k", metaKey: true });
    expect(txt(el, "open")).toBe("false");
  });

  it("opens on Ctrl+K (non-mac chord)", () => {
    const el = renderLive(createElement(Harness, {}));
    fireKey(document, { key: "K", ctrlKey: true });
    expect(txt(el, "open")).toBe("true");
  });

  it("opens on a bare / outside a field, but not while typing in one", () => {
    const el = renderLive(createElement(Harness, {}));

    const external = el.querySelector('[data-testid="external"]') as HTMLInputElement;
    fireKey(external, { key: "/" });
    expect(txt(el, "open")).toBe("false");

    fireKey(document.body, { key: "/" });
    expect(txt(el, "open")).toBe("true");
  });

  it("navigates the list with arrows (wrapping), Home and End", () => {
    const el = renderLive(createElement(Harness, { initialCount: 3 }));
    fireKey(document, { key: "k", metaKey: true });
    const input = el.querySelector('[data-testid="input"]') as HTMLInputElement;
    expect(txt(el, "active")).toBe("0");

    fireKey(input, { key: "ArrowDown" });
    expect(txt(el, "active")).toBe("1");
    fireKey(input, { key: "ArrowDown" });
    fireKey(input, { key: "ArrowDown" });
    expect(txt(el, "active")).toBe("0"); // wrapped past the end

    fireKey(input, { key: "ArrowUp" });
    expect(txt(el, "active")).toBe("2"); // wrapped past the start

    fireKey(input, { key: "Home" });
    expect(txt(el, "active")).toBe("0");
    fireKey(input, { key: "End" });
    expect(txt(el, "active")).toBe("2");
  });

  it("reflects the active option via aria-selected", () => {
    const el = renderLive(createElement(Harness, { initialCount: 3 }));
    fireKey(document, { key: "k", metaKey: true });
    const input = el.querySelector('[data-testid="input"]') as HTMLInputElement;
    fireKey(input, { key: "ArrowDown" });

    expect(el.querySelector('[data-testid="opt-1"]')?.getAttribute("aria-selected")).toBe("true");
    expect(el.querySelector('[data-testid="opt-0"]')?.getAttribute("aria-selected")).toBe("false");
  });

  it("highlights an option on mouse move", () => {
    const el = renderLive(createElement(Harness, { initialCount: 3 }));
    fireKey(document, { key: "k", metaKey: true });
    const opt2 = el.querySelector('[data-testid="opt-2"]') as HTMLElement;
    act(() => {
      opt2.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    expect(txt(el, "active")).toBe("2");
  });

  it("calls onSelect with the active index on Enter", () => {
    const onSelect = vi.fn();
    const el = renderLive(createElement(Harness, { initialCount: 3, onSelect }));
    fireKey(document, { key: "k", metaKey: true });
    const input = el.querySelector('[data-testid="input"]') as HTMLInputElement;
    fireKey(input, { key: "ArrowDown" });
    fireKey(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("closes on Escape", () => {
    const el = renderLive(createElement(Harness, {}));
    fireKey(document, { key: "k", metaKey: true });
    expect(txt(el, "open")).toBe("true");
    const input = el.querySelector('[data-testid="input"]') as HTMLInputElement;
    fireKey(input, { key: "Escape" });
    expect(txt(el, "open")).toBe("false");
  });

  it("clamps the active index when the list shrinks under it", () => {
    const el = renderLive(createElement(Harness, { initialCount: 3 }));
    fireKey(document, { key: "k", metaKey: true });
    const input = el.querySelector('[data-testid="input"]') as HTMLInputElement;
    fireKey(input, { key: "End" });
    expect(txt(el, "active")).toBe("2");

    act(() => {
      (el.querySelector('[data-testid="shrink"]') as HTMLButtonElement).click();
    });
    expect(txt(el, "active")).toBe("0");
  });

  it("locks body scroll while open and restores it on close", () => {
    const el = renderLive(createElement(Harness, {}));
    expect(document.body.style.overflow).toBe("");
    fireKey(document, { key: "k", metaKey: true });
    expect(document.body.style.overflow).toBe("hidden");
    const input = el.querySelector('[data-testid="input"]') as HTMLInputElement;
    fireKey(input, { key: "Escape" });
    expect(document.body.style.overflow).toBe("");
  });

  it("fires onOpenChange on transitions but not on mount", () => {
    const onOpenChange = vi.fn();
    renderLive(createElement(Harness, { onOpenChange }));
    expect(onOpenChange).not.toHaveBeenCalled();
    fireKey(document, { key: "k", metaKey: true });
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    fireKey(document, { key: "k", metaKey: true });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("traps Tab so focus cannot leave the open dialog", () => {
    const el = renderLive(createElement(Harness, {}));
    fireKey(document, { key: "k", metaKey: true });
    const input = el.querySelector('[data-testid="input"]') as HTMLInputElement;
    const event = fireKey(input, { key: "Tab" });
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not wrap at the ends when loop is false", () => {
    const el = renderLive(createElement(Harness, { initialCount: 3, loop: false }));
    fireKey(document, { key: "k", metaKey: true });
    const input = el.querySelector('[data-testid="input"]') as HTMLInputElement;

    fireKey(input, { key: "ArrowUp" }); // already at 0 → stays 0
    expect(txt(el, "active")).toBe("0");

    fireKey(input, { key: "End" });
    fireKey(input, { key: "ArrowDown" }); // at last → stays last
    expect(txt(el, "active")).toBe("2");
  });

  it("does not open on / when openOnSlash is false", () => {
    const el = renderLive(createElement(Harness, { openOnSlash: false }));
    fireKey(document.body, { key: "/" });
    expect(txt(el, "open")).toBe("false");
  });

  it("can start open via defaultOpen", () => {
    const el = renderLive(createElement(Harness, { defaultOpen: true }));
    expect(txt(el, "open")).toBe("true");
  });
});

// ===========================================================================
// CommandPalette — the batteries-included component
// ===========================================================================

const INDEX: Tier0Index = {
  version: 0,
  builtAt: "2026-06-22T00:00:00.000Z",
  entries: [
    {
      id: "queue",
      slug: "/batteries/queue",
      collection: "docs",
      title: "Queue jobs",
      snippet: "Background queue jobs on the database.",
      keywords: ["queue", "jobs", "background", "database"],
    },
    {
      id: "auth",
      slug: "/batteries/auth",
      collection: "docs",
      title: "Auth and sessions",
      snippet: "Login, sessions, two factor.",
      keywords: ["auth", "login", "sessions"],
    },
  ],
};

/** Resolve fetch() with the test index; flush the load + a tick. */
function stubFetchOk(index: Tier0Index = INDEX): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    json: async () => index,
  } as Response);
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("CommandPalette", () => {
  beforeEach(() => {
    document.body.style.overflow = "";
  });

  it("renders a trigger with a keyboard hint and opens on click", async () => {
    stubFetchOk();
    const el = renderLive(createElement(CommandPalette, {}));
    await flush();

    const trigger = el.querySelector(".lesto-cmdk-trigger") as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    expect(el.querySelector(".lesto-cmdk-kbd")?.textContent).toMatch(/K$/);
    expect(el.querySelector(".lesto-cmdk-dialog")).toBeNull();

    act(() => trigger.click());
    const dialog = el.querySelector(".lesto-cmdk-dialog");
    expect(dialog).not.toBeNull();
    expect(document.activeElement).toBe(el.querySelector(".lesto-cmdk-input"));
  });

  it("shows guidance and the empty label as the query changes", async () => {
    stubFetchOk();
    const el = renderLive(createElement(CommandPalette, { emptyLabel: "Nothing here" }));
    await flush();
    act(() => (el.querySelector(".lesto-cmdk-trigger") as HTMLButtonElement).click());

    expect(el.querySelector(".lesto-cmdk-empty")?.textContent).toBe("Type to search");

    const input = el.querySelector(".lesto-cmdk-input") as HTMLInputElement;
    typeInto(input, "zzzznomatch");
    expect(el.querySelector(".lesto-cmdk-empty")?.textContent).toBe("Nothing here");
  });

  it("ranks matching results and navigates on click", async () => {
    stubFetchOk();
    const onNavigate = vi.fn();
    const el = renderLive(createElement(CommandPalette, { onNavigate }));
    await flush();
    act(() => (el.querySelector(".lesto-cmdk-trigger") as HTMLButtonElement).click());

    const input = el.querySelector(".lesto-cmdk-input") as HTMLInputElement;
    typeInto(input, "queue");

    const links = el.querySelectorAll<HTMLAnchorElement>(".lesto-cmdk-item-link");
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]?.textContent).toContain("Queue jobs");
    expect(links[0]?.getAttribute("href")).toBe("/batteries/queue");

    act(() => links[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })));
    expect(onNavigate).toHaveBeenCalledWith("/batteries/queue");
    expect(el.querySelector(".lesto-cmdk-dialog")).toBeNull(); // closed after select
  });

  it("selects the active result with Enter", async () => {
    stubFetchOk();
    const onNavigate = vi.fn();
    const el = renderLive(createElement(CommandPalette, { onNavigate }));
    await flush();
    act(() => (el.querySelector(".lesto-cmdk-trigger") as HTMLButtonElement).click());

    const input = el.querySelector(".lesto-cmdk-input") as HTMLInputElement;
    typeInto(input, "queue");
    fireKey(input, { key: "Enter" });
    expect(onNavigate).toHaveBeenCalledWith("/batteries/queue");
  });

  it("honors modified clicks (new tab) without intercepting navigation", async () => {
    stubFetchOk();
    const onNavigate = vi.fn();
    const el = renderLive(createElement(CommandPalette, { onNavigate }));
    await flush();
    act(() => (el.querySelector(".lesto-cmdk-trigger") as HTMLButtonElement).click());
    typeInto(el.querySelector(".lesto-cmdk-input") as HTMLInputElement, "queue");

    const link = el.querySelector(".lesto-cmdk-item-link") as HTMLAnchorElement;
    act(() => link.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })));
    expect(onNavigate).not.toHaveBeenCalled(); // browser handles the new-tab open
    expect(el.querySelector(".lesto-cmdk-dialog")).toBeNull(); // palette still closes
  });

  it("shows a loading state until the index resolves", async () => {
    // A fetch that never settles keeps index null.
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise(() => {}) as Promise<Response>);
    const el = renderLive(createElement(CommandPalette, {}));
    act(() => (el.querySelector(".lesto-cmdk-trigger") as HTMLButtonElement).click());
    expect(el.querySelector(".lesto-cmdk-empty")?.textContent).toBe("Loading…");
  });

  it("degrades gracefully when the index fails to load", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const el = renderLive(createElement(CommandPalette, {}));
    await flush();
    // Trigger still works; the page is not broken.
    expect(el.querySelector(".lesto-cmdk-trigger")).not.toBeNull();
  });

  it("renders a Mac chord hint when on a Mac", async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "platform");
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    try {
      stubFetchOk();
      const el = renderLive(createElement(CommandPalette, {}));
      await flush();
      expect(el.querySelector(".lesto-cmdk-kbd")?.textContent).toBe("⌘K");
    } finally {
      if (original) Object.defineProperty(navigator, "platform", original);
    }
  });

  it("supports a custom trigger via renderTrigger", async () => {
    stubFetchOk();
    const el = renderLive(
      createElement(CommandPalette, {
        renderTrigger: ({ open, shortcutHint }) =>
          createElement(
            "button",
            { "data-testid": "custom", onClick: open },
            `find ${shortcutHint}`,
          ),
      }),
    );
    await flush();
    const custom = el.querySelector('[data-testid="custom"]') as HTMLButtonElement;
    expect(custom.textContent).toContain("find");
    expect(el.querySelector(".lesto-cmdk-trigger")).toBeNull(); // default trigger replaced
    act(() => custom.click());
    expect(el.querySelector(".lesto-cmdk-dialog")).not.toBeNull();
  });

  it("closes when the overlay backdrop is clicked", async () => {
    stubFetchOk();
    const el = renderLive(createElement(CommandPalette, {}));
    await flush();
    act(() => (el.querySelector(".lesto-cmdk-trigger") as HTMLButtonElement).click());

    const overlay = el.querySelector(".lesto-cmdk-overlay") as HTMLElement;
    act(() => overlay.click());
    expect(el.querySelector(".lesto-cmdk-dialog")).toBeNull();
  });

  it("neutralizes a dangerous result URL (javascript:) to '#'", async () => {
    const evil: Tier0Index = {
      version: 0,
      builtAt: "2026-06-22T00:00:00.000Z",
      entries: [
        {
          id: "x",
          slug: "javascript:alert(1)",
          collection: "docs",
          title: "Pwn",
          snippet: "x",
          keywords: ["pwn"],
        },
      ],
    };
    stubFetchOk(evil);
    const onNavigate = vi.fn();
    const el = renderLive(createElement(CommandPalette, { onNavigate }));
    await flush();
    act(() => (el.querySelector(".lesto-cmdk-trigger") as HTMLButtonElement).click());
    typeInto(el.querySelector(".lesto-cmdk-input") as HTMLInputElement, "pwn");

    const link = el.querySelector(".lesto-cmdk-item-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("#"); // never the javascript: URL
    act(() => link.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })));
    expect(onNavigate).toHaveBeenCalledWith("#"); // and never navigated to it
  });

  it("returns focus to the trigger when the dialog closes", async () => {
    stubFetchOk();
    const el = renderLive(createElement(CommandPalette, {}));
    await flush();
    const trigger = el.querySelector(".lesto-cmdk-trigger") as HTMLButtonElement;
    act(() => trigger.focus());
    fireKey(document, { key: "k", metaKey: true }); // open via shortcut
    expect(document.activeElement).toBe(el.querySelector(".lesto-cmdk-input"));

    fireKey(el.querySelector(".lesto-cmdk-input") as HTMLInputElement, { key: "Escape" });
    expect(document.activeElement).toBe(trigger); // focus restored
  });

  // The default sink (window.location.assign) cannot be exercised under jsdom —
  // its location.assign is non-configurable and navigation is unimplemented. The
  // navigation *logic* (safeHref + the onNavigate sink) is covered by the tests
  // above; only the 2-line fallback branch picking the sink is left uncovered.

  it("forwards collections and limit to the search function", async () => {
    stubFetchOk();
    const search = vi.fn().mockReturnValue([]);
    const el = renderLive(
      createElement(CommandPalette, { search, collections: ["docs"], limit: 5 }),
    );
    await flush();
    act(() => (el.querySelector(".lesto-cmdk-trigger") as HTMLButtonElement).click());
    typeInto(el.querySelector(".lesto-cmdk-input") as HTMLInputElement, "q");
    expect(search).toHaveBeenCalledWith(
      "q",
      expect.anything(),
      expect.objectContaining({ collections: ["docs"], limit: 5 }),
    );
  });

  it("applies a custom className to the dialog", async () => {
    stubFetchOk();
    const el = renderLive(createElement(CommandPalette, { className: "my-shell" }));
    await flush();
    act(() => (el.querySelector(".lesto-cmdk-trigger") as HTMLButtonElement).click());
    expect((el.querySelector(".lesto-cmdk-dialog") as HTMLElement).className).toContain("my-shell");
  });

  it("keeps a safe https result URL but blocks protocol-relative //host", async () => {
    const idx: Tier0Index = {
      version: 0,
      builtAt: "2026-06-22T00:00:00.000Z",
      entries: [
        {
          id: "a",
          slug: "https://lesto.run/x",
          collection: "docs",
          title: "Ext",
          snippet: "y",
          keywords: ["ext"],
        },
        {
          id: "b",
          slug: "//evil.com",
          collection: "docs",
          title: "Evil",
          snippet: "z",
          keywords: ["evil"],
        },
      ],
    };
    stubFetchOk(idx);
    const el = renderLive(createElement(CommandPalette, {}));
    await flush();
    act(() => (el.querySelector(".lesto-cmdk-trigger") as HTMLButtonElement).click());
    const input = el.querySelector(".lesto-cmdk-input") as HTMLInputElement;

    typeInto(input, "ext");
    expect(
      (el.querySelector(".lesto-cmdk-item-link") as HTMLAnchorElement).getAttribute("href"),
    ).toBe("https://lesto.run/x");

    typeInto(input, "evil");
    expect(
      (el.querySelector(".lesto-cmdk-item-link") as HTMLAnchorElement).getAttribute("href"),
    ).toBe("#");
  });
});

describe("commandPaletteStyles", () => {
  it("is a non-empty stylesheet keyed off the public class names", () => {
    expect(commandPaletteStyles).toContain(".lesto-cmdk-trigger");
    expect(commandPaletteStyles).toContain(".lesto-cmdk-dialog");
    expect(commandPaletteStyles).toContain('[aria-selected="true"]');
  });
});
