// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from "vitest";
import { enhancePackageCommands } from "../package-commands-client";

const PMS = ["npm", "pnpm", "yarn", "bun"];

/** Build one server-rendered tab group, npm selected (mirrors the plugin output). */
function groupHtml(): string {
  const tabs = PMS.map(
    (pm) =>
      `<button class="lesto-pm-tab" data-pm="${pm}" role="tab" aria-selected="${
        pm === "npm"
      }" tabindex="${pm === "npm" ? 0 : -1}">${pm}</button>`,
  ).join("");
  const panels = PMS.map(
    (pm) =>
      `<div class="lesto-pm-panel" data-pm="${pm}" role="tabpanel"${
        pm === "npm" ? "" : " hidden"
      }>${pm} cmd</div>`,
  ).join("");
  return `<div class="lesto-pm-tabs" data-pm-tabs>
    <div class="lesto-pm-tablist" role="tablist">${tabs}</div>
    <div class="lesto-pm-panels">${panels}</div>
  </div>`;
}

function tab(group: Element, pm: string): HTMLButtonElement {
  return group.querySelector(`[role="tab"][data-pm="${pm}"]`) as HTMLButtonElement;
}
function panel(group: Element, pm: string): HTMLElement {
  return group.querySelector(`[role="tabpanel"][data-pm="${pm}"]`) as HTMLElement;
}

function fakeStorage(initial: string | null = null) {
  return {
    getItem: vi.fn(() => initial),
    setItem: vi.fn(),
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
});

describe("enhancePackageCommands", () => {
  it("switches the visible panel when a tab is clicked", () => {
    document.body.innerHTML = groupHtml();
    const group = document.querySelector("[data-pm-tabs]")!;
    enhancePackageCommands({ storage: null });

    expect(panel(group, "npm").hasAttribute("hidden")).toBe(false);
    tab(group, "pnpm").click();

    expect(panel(group, "pnpm").hasAttribute("hidden")).toBe(false);
    expect(panel(group, "npm").hasAttribute("hidden")).toBe(true);
    expect(tab(group, "pnpm").getAttribute("aria-selected")).toBe("true");
    expect(tab(group, "pnpm").tabIndex).toBe(0);
    expect(tab(group, "npm").tabIndex).toBe(-1);
  });

  it("keeps every group on the page in sync", () => {
    document.body.innerHTML = groupHtml() + groupHtml();
    const [a, b] = Array.from(document.querySelectorAll("[data-pm-tabs]"));
    enhancePackageCommands({ storage: null });

    tab(a!, "yarn").click();

    for (const group of [a!, b!]) {
      expect(panel(group, "yarn").hasAttribute("hidden")).toBe(false);
      expect(panel(group, "npm").hasAttribute("hidden")).toBe(true);
    }
  });

  it("persists the choice to storage", () => {
    document.body.innerHTML = groupHtml();
    const storage = fakeStorage();
    enhancePackageCommands({ storage });

    tab(document.querySelector("[data-pm-tabs]")!, "bun").click();
    expect(storage.setItem).toHaveBeenCalledWith("lesto-pm", "bun");
  });

  it("applies a remembered choice on init", () => {
    document.body.innerHTML = groupHtml();
    enhancePackageCommands({ storage: fakeStorage("bun") });

    const group = document.querySelector("[data-pm-tabs]")!;
    expect(panel(group, "bun").hasAttribute("hidden")).toBe(false);
    expect(panel(group, "npm").hasAttribute("hidden")).toBe(true);
  });

  it("moves and activates with the arrow keys", () => {
    document.body.innerHTML = groupHtml();
    const group = document.querySelector("[data-pm-tabs]")!;
    enhancePackageCommands({ storage: null });

    tab(group, "npm").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(tab(group, "pnpm").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab(group, "pnpm"));

    // Wraps from the first tab backwards to the last.
    tab(group, "pnpm").dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    tab(group, "npm").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(tab(group, "bun").getAttribute("aria-selected")).toBe("true");
  });

  it("does not double-bind when called twice (idempotent)", () => {
    document.body.innerHTML = groupHtml();
    const storage = fakeStorage();
    enhancePackageCommands({ storage });
    enhancePackageCommands({ storage }); // second call must not re-bind

    tab(document.querySelector("[data-pm-tabs]")!, "pnpm").click();
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("no-ops when there are no groups or no DOM", () => {
    document.body.innerHTML = "<p>nothing here</p>";
    expect(() => enhancePackageCommands()).not.toThrow();
    expect(() => enhancePackageCommands({ root: null })).not.toThrow();
  });

  it("ignores a stored manager a group does not offer", () => {
    document.body.innerHTML = groupHtml();
    enhancePackageCommands({ storage: fakeStorage("deno") });

    // Unknown manager: the group keeps its server default (npm visible).
    const group = document.querySelector("[data-pm-tabs]")!;
    expect(panel(group, "npm").hasAttribute("hidden")).toBe(false);
  });

  it("persists to localStorage by default and re-reads it", () => {
    document.body.innerHTML = groupHtml();
    enhancePackageCommands(); // no storage option → uses localStorage
    tab(document.querySelector("[data-pm-tabs]")!, "pnpm").click();
    expect(localStorage.getItem("lesto-pm")).toBe("pnpm");

    // A second group rendered later picks up the remembered choice on enhance.
    document.body.innerHTML = groupHtml();
    enhancePackageCommands();
    const group = document.querySelector("[data-pm-tabs]")!;
    expect(panel(group, "pnpm").hasAttribute("hidden")).toBe(false);
  });

  it("degrades gracefully when storage throws", () => {
    document.body.innerHTML = groupHtml();
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => enhancePackageCommands({ storage: throwing })).not.toThrow();
    const group = document.querySelector("[data-pm-tabs]")!;
    expect(() => tab(group, "bun").click()).not.toThrow();
    // The in-page switch still works even though persistence failed.
    expect(panel(group, "bun").hasAttribute("hidden")).toBe(false);
  });

  it("ignores keys other than the arrow/Home/End set", () => {
    document.body.innerHTML = groupHtml();
    const group = document.querySelector("[data-pm-tabs]")!;
    enhancePackageCommands({ storage: null });
    tab(group, "npm").dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(tab(group, "npm").getAttribute("aria-selected")).toBe("true"); // unchanged
  });
});
