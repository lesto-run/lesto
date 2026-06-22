/// <reference lib="dom" />

/**
 * Client enhancer for {@link rehypePackageCommands} output.
 *
 * Framework-agnostic and dependency-free: it attaches behavior to the
 * server-rendered tab markup rather than rendering anything, so any site (React,
 * none, whatever) can call it once on load. It:
 *
 *  - switches the visible panel when a tab is clicked,
 *  - keeps every block on the page in sync (pick `pnpm` once, all blocks follow),
 *  - remembers the choice in `localStorage`, and
 *  - implements the WAI-ARIA tabs keyboard model (arrows / Home / End).
 *
 * It only toggles attributes it finds — it never sets `innerHTML` or reads
 * untrusted strings — so it introduces no injection surface. It is idempotent:
 * calling it twice does not double-bind handlers.
 */

export interface EnhancePackageCommandsOptions {
  /** Where to look for tab groups. Default: `document`. */
  root?: ParentNode | null;
  /** `localStorage` key for the remembered manager. Default `"lesto-pm"`. */
  storageKey?: string;
  /**
   * Storage to persist the choice in. Default: `localStorage` when available.
   * Pass `null` to disable persistence (the choice still syncs within the page).
   */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    // Access can throw (privacy modes, sandboxed iframes) — degrade silently.
    return null;
  }
}

/** Select `pm` within one group: update tab state and show the matching panel.
 *  A group that does not offer `pm` is left untouched. */
function applyToGroup(group: HTMLElement, pm: string): void {
  const tabs = Array.from(group.querySelectorAll<HTMLElement>('[role="tab"]'));
  let matched = false;
  for (const tab of tabs) {
    const active = tab.dataset["pm"] === pm;
    matched = matched || active;
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
  }
  if (!matched) return;
  const panels = Array.from(group.querySelectorAll<HTMLElement>('[role="tabpanel"]'));
  for (const panel of panels) {
    if (panel.dataset["pm"] === pm) panel.removeAttribute("hidden");
    else panel.setAttribute("hidden", "");
  }
}

/**
 * Wire up every package-manager tab group under `root`. Safe to call on any page
 * (no-ops when there are no groups or there is no DOM).
 */
export function enhancePackageCommands(options: EnhancePackageCommandsOptions = {}): void {
  const root = options.root ?? (typeof document !== "undefined" ? document : null);
  if (!root) return;

  const storageKey = options.storageKey ?? "lesto-pm";
  const storage = options.storage !== undefined ? options.storage : defaultStorage();

  const groups = Array.from(root.querySelectorAll<HTMLElement>("[data-pm-tabs]"));
  if (groups.length === 0) return;

  function select(pm: string, focus?: HTMLElement): void {
    for (const group of groups) applyToGroup(group, pm);
    if (focus) focus.focus();
    try {
      storage?.setItem(storageKey, pm);
    } catch {
      // Persistence is best-effort.
    }
  }

  for (const group of groups) {
    if (group.dataset["pmReady"] === "true") continue;
    group.dataset["pmReady"] = "true";

    const tabs = Array.from(group.querySelectorAll<HTMLElement>('[role="tab"]'));

    tabs.forEach((tab, index) => {
      const pm = tab.dataset["pm"];
      if (!pm) return;

      tab.addEventListener("click", () => select(pm));

      tab.addEventListener("keydown", (event: KeyboardEvent) => {
        let nextIndex: number | null = null;
        switch (event.key) {
          case "ArrowRight":
          case "ArrowDown":
            nextIndex = (index + 1) % tabs.length;
            break;
          case "ArrowLeft":
          case "ArrowUp":
            nextIndex = (index - 1 + tabs.length) % tabs.length;
            break;
          case "Home":
            nextIndex = 0;
            break;
          case "End":
            nextIndex = tabs.length - 1;
            break;
          default:
            return;
        }
        event.preventDefault();
        const nextTab = tabs[nextIndex];
        const nextPm = nextTab?.dataset["pm"];
        if (nextPm) select(nextPm, nextTab); // automatic activation, focus follows
      });
    });
  }

  // Apply a remembered choice across the page.
  let stored: string | null = null;
  try {
    stored = storage?.getItem(storageKey) ?? null;
  } catch {
    stored = null;
  }
  if (stored) {
    for (const group of groups) applyToGroup(group, stored);
  }
}

export default enhancePackageCommands;
