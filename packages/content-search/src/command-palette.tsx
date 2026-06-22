/// <reference lib="dom" />

/**
 * @lesto/content-search/react — Cmd+K command palette
 *
 * A batteries-included, accessible search palette for docs and app shells.
 *
 * Two layers ship here, smallest reusable piece first:
 *
 *  - {@link useCommandPalette} is a *headless* controller. It owns the open/close
 *    state, the global `⌘K` / `Ctrl+K` (and `/`) shortcut, keyboard list
 *    navigation (arrows, Home/End, Enter, Escape), body-scroll locking, and the
 *    ARIA prop-getters (`combobox` + `listbox` + `option`). It knows nothing
 *    about *searching* — you tell it how many items are shown and what to do on
 *    select, so it composes over any result source.
 *
 *  - {@link CommandPalette} is the zero-config component: it wires the controller
 *    to the prerendered keyword index (via {@link keywordSearch}, the same ranking
 *    the rest of the package uses) and renders a themeable dialog. Drop one in a
 *    header and you have a working `⌘K`. Override {@link CommandPaletteProps.search}
 *    or {@link CommandPaletteProps.onNavigate} to repoint it.
 *
 * Ship {@link commandPaletteStyles} (a plain CSS string, themed off CSS custom
 * properties with sensible fallbacks) into your stylesheet for the default look.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { keywordSearch } from "./progressive";
import type { SearchOptions, SearchResult, Tier0Index } from "./types";

// ============================================================================
// Headless controller
// ============================================================================

export interface UseCommandPaletteOptions {
  /** How many selectable items are currently shown (drives arrow navigation). */
  count: number;
  /** Invoked with the active index when the user presses Enter on a result. */
  onSelect?: (index: number) => void;
  /** Notified whenever the palette opens or closes (never on mount). */
  onOpenChange?: (open: boolean) => void;
  /** The letter pressed with ⌘/Ctrl to toggle the palette. Default `"k"`. */
  shortcut?: string;
  /** Also open on a bare `/` when focus is not in a field. Default `true`. */
  openOnSlash?: boolean;
  /** Lock background scroll while the palette is open. Default `true`. */
  lockScroll?: boolean;
  /** Wrap arrow navigation at the ends of the list. Default `true`. */
  loop?: boolean;
  /** Start open (mostly for tests / controlled shells). Default `false`. */
  defaultOpen?: boolean;
}

export interface CommandItemProps {
  role: "option";
  id: string;
  "aria-selected": boolean;
  onMouseMove: () => void;
}

export interface UseCommandPaletteReturn {
  open: boolean;
  /** Index of the highlighted item (`-1` when the list is empty). */
  active: number;
  /** DOM id of the active option, or `undefined` when the list is empty. */
  activeId: string | undefined;
  openPalette: () => void;
  closePalette: () => void;
  toggle: () => void;
  setActive: (index: number) => void;
  triggerProps: {
    type: "button";
    "aria-haspopup": "dialog";
    "aria-expanded": boolean;
    "aria-keyshortcuts": string;
    onClick: () => void;
  };
  overlayProps: { onClick: () => void };
  dialogProps: {
    role: "dialog";
    "aria-modal": true;
    onKeyDown: (event: ReactKeyboardEvent) => void;
    onMouseDown: (event: ReactMouseEvent) => void;
  };
  inputProps: {
    role: "combobox";
    "aria-expanded": true;
    "aria-controls": string;
    "aria-autocomplete": "list";
    "aria-activedescendant": string | undefined;
  };
  listProps: { role: "listbox"; id: string };
  getItemProps: (index: number) => CommandItemProps;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function nextIndex(prev: number, count: number, loop: boolean): number {
  if (count <= 0) return 0;
  if (prev + 1 < count) return prev + 1;
  return loop ? 0 : count - 1;
}

function prevIndex(prev: number, count: number, loop: boolean): number {
  if (count <= 0) return 0;
  if (prev - 1 >= 0) return prev - 1;
  return loop ? count - 1 : 0;
}

/**
 * Headless command-palette controller: open state, the global shortcut, keyboard
 * list navigation, scroll locking, and ARIA wiring. Bring your own results.
 */
export function useCommandPalette(options: UseCommandPaletteOptions): UseCommandPaletteReturn {
  const {
    count,
    onSelect,
    onOpenChange,
    shortcut = "k",
    openOnSlash = true,
    lockScroll = true,
    loop = true,
    defaultOpen = false,
  } = options;

  const [open, setOpen] = useState(defaultOpen);
  const [active, setActiveState] = useState(0);

  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = useCallback((index: number) => `${baseId}-opt-${index}`, [baseId]);

  const openPalette = useCallback(() => setOpen(true), []);
  const closePalette = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((prev) => !prev), []);

  const setActive = useCallback(
    (index: number) => {
      if (count <= 0) return;
      const clamped = ((index % count) + count) % count;
      setActiveState(clamped);
    },
    [count],
  );

  // Reset the highlight to the top each time the palette opens.
  useEffect(() => {
    if (open) setActiveState(0);
  }, [open]);

  // Keep the highlight in range as the result list shrinks/grows under it.
  useEffect(() => {
    setActiveState((prev) => (prev >= count ? 0 : prev));
  }, [count]);

  // Notify on transitions only — never on the initial mount.
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) {
      onOpenChange?.(open);
    } else {
      mounted.current = true;
    }
  }, [open, onOpenChange]);

  // Lock background scroll while open, restoring whatever was there before.
  useEffect(() => {
    if (!open || !lockScroll || typeof document === "undefined") return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open, lockScroll]);

  // The global open shortcut (⌘K / Ctrl+K, and bare `/`) — always live so the
  // palette can be summoned from anywhere on the page.
  useEffect(() => {
    if (typeof document === "undefined") return;
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === shortcut.toLowerCase()) {
        event.preventDefault();
        toggle();
        return;
      }
      if (openOnSlash && event.key === "/" && !isEditableTarget(event.target)) {
        event.preventDefault();
        setOpen(true);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [shortcut, openOnSlash, toggle]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setActiveState((prev) => nextIndex(prev, count, loop));
          break;
        case "ArrowUp":
          event.preventDefault();
          setActiveState((prev) => prevIndex(prev, count, loop));
          break;
        case "Home":
          event.preventDefault();
          setActiveState(0);
          break;
        case "End":
          event.preventDefault();
          setActiveState(count <= 0 ? 0 : count - 1);
          break;
        case "Enter":
          if (count > 0) {
            event.preventDefault();
            onSelect?.(active);
          }
          break;
        case "Escape":
          event.preventDefault();
          setOpen(false);
          break;
      }
    },
    [count, loop, active, onSelect],
  );

  const activeId = count > 0 ? optionId(active) : undefined;

  return {
    open,
    active: count > 0 ? active : -1,
    activeId,
    openPalette,
    closePalette,
    toggle,
    setActive,
    triggerProps: {
      type: "button",
      "aria-haspopup": "dialog",
      "aria-expanded": open,
      "aria-keyshortcuts": "Meta+K Control+K",
      onClick: openPalette,
    },
    overlayProps: { onClick: closePalette },
    dialogProps: {
      role: "dialog",
      "aria-modal": true,
      onKeyDown: handleKeyDown,
      // Clicks inside the dialog must not reach the overlay's close handler.
      onMouseDown: (event: ReactMouseEvent) => event.stopPropagation(),
    },
    inputProps: {
      role: "combobox",
      "aria-expanded": true,
      "aria-controls": listId,
      "aria-autocomplete": "list",
      "aria-activedescendant": activeId,
    },
    listProps: { role: "listbox", id: listId },
    getItemProps: (index: number) => ({
      role: "option",
      id: optionId(index),
      "aria-selected": index === active,
      onMouseMove: () => setActiveState(index),
    }),
  };
}

// ============================================================================
// Batteries-included component
// ============================================================================

type SearchFn = (query: string, index: Tier0Index, options: SearchOptions) => SearchResult[];

export interface CommandPaletteProps {
  /** Where the prerendered keyword index lives. Default `"/search-index.json"`. */
  indexPath?: string;
  /** Restrict results to these collections (passed through to the search fn). */
  collections?: string[];
  /** Max results shown. Default `8`. */
  limit?: number;
  /** Input placeholder. Default `"Search docs…"`. */
  placeholder?: string;
  /** Trigger button label. Default `"Search"`. */
  triggerLabel?: string;
  /** Shown when a query matches nothing. Default `"No results"`. */
  emptyLabel?: string;
  /** ⌘/Ctrl + this key opens the palette. Default `"k"`. */
  shortcut?: string;
  /** Ranking function over the loaded index. Default {@link keywordSearch}. */
  search?: SearchFn;
  /** Navigate to a chosen result. Default: same-tab `location.assign`. */
  onNavigate?: (slug: string) => void;
  /** Render a custom trigger instead of the default button. */
  renderTrigger?: (api: { open: () => void; shortcutHint: string }) => ReactNode;
  /** Extra class on the dialog root. */
  className?: string;
}

function detectMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    navigator.userAgent ??
    "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * A zero-config `⌘K` search palette wired to the prerendered keyword index.
 *
 * Renders a trigger button plus, when open, a modal dialog with a search input
 * and a keyboard-navigable result list. Server-render its host island's static
 * fallback; this mounts on the client.
 */
export function CommandPalette(props: CommandPaletteProps): ReactElement {
  const {
    indexPath = "/search-index.json",
    collections,
    limit = 8,
    placeholder = "Search docs…",
    triggerLabel = "Search",
    emptyLabel = "No results",
    shortcut = "k",
    search = keywordSearch,
    onNavigate,
    renderTrigger,
    className,
  } = props;

  const [index, setIndex] = useState<Tier0Index | null>(null);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const isMac = useMemo(detectMac, []);
  const shortcutHint = isMac ? "⌘K" : "Ctrl K";

  // Load the prerendered index once; search degrades to absent if it can't.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetch(indexPath);
        const loaded = (await response.json()) as Tier0Index;
        if (live) setIndex(loaded);
      } catch {
        // The page still works without search.
      }
    })();
    return () => {
      live = false;
    };
  }, [indexPath]);

  const results = useMemo<SearchResult[]>(() => {
    if (index === null || query.trim() === "") return [];
    return search(query, index, { limit, ...(collections && { collections }) });
  }, [index, query, search, limit, collections]);

  const navigate = useCallback(
    (slug: string) => {
      if (onNavigate) {
        onNavigate(slug);
      } else if (typeof window !== "undefined") {
        window.location.assign(slug);
      }
    },
    [onNavigate],
  );

  const palette = useCommandPalette({
    count: results.length,
    shortcut,
    onSelect: (i) => {
      const hit = results[i];
      if (hit) {
        palette.closePalette();
        navigate(hit.slug);
      }
    },
  });

  // Focus the input as the dialog opens; clear the query as it closes.
  useEffect(() => {
    if (palette.open) {
      inputRef.current?.focus();
    } else {
      setQuery("");
    }
  }, [palette.open]);

  // Keep the highlighted option scrolled into view during keyboard navigation.
  useEffect(() => {
    if (!palette.open || !palette.activeId || typeof document === "undefined") return;
    const active = document.getElementById(palette.activeId);
    // `scrollIntoView` is absent in some runtimes (jsdom, older WebViews).
    active?.scrollIntoView?.({ block: "nearest" });
  }, [palette.open, palette.activeId]);

  function onResultClick(event: ReactMouseEvent, hit: SearchResult): void {
    // Honor modified clicks (new tab / window) — just close and let the browser go.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
      palette.closePalette();
      return;
    }
    event.preventDefault();
    palette.closePalette();
    navigate(hit.slug);
  }

  const emptyText =
    index === null ? "Loading…" : query.trim() === "" ? "Type to search" : emptyLabel;

  return (
    <>
      {renderTrigger ? (
        renderTrigger({ open: palette.openPalette, shortcutHint })
      ) : (
        <button className="lesto-cmdk-trigger" {...palette.triggerProps}>
          <span className="lesto-cmdk-trigger-icon" aria-hidden="true">
            ⌕
          </span>
          <span className="lesto-cmdk-trigger-label">{triggerLabel}</span>
          <kbd className="lesto-cmdk-kbd">{shortcutHint}</kbd>
        </button>
      )}

      {palette.open ? (
        <div className="lesto-cmdk-overlay" {...palette.overlayProps}>
          <div
            className={className ? `lesto-cmdk-dialog ${className}` : "lesto-cmdk-dialog"}
            aria-label={triggerLabel}
            {...palette.dialogProps}
          >
            <input
              ref={inputRef}
              className="lesto-cmdk-input"
              type="search"
              placeholder={placeholder}
              aria-label={triggerLabel}
              value={query}
              onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
              {...palette.inputProps}
            />
            <ul className="lesto-cmdk-list" {...palette.listProps}>
              {results.length === 0 ? (
                <li className="lesto-cmdk-empty" aria-disabled="true">
                  {emptyText}
                </li>
              ) : (
                results.map((hit, i) => (
                  <li key={hit.id} className="lesto-cmdk-item">
                    <a
                      className="lesto-cmdk-item-link"
                      href={hit.slug}
                      onClick={(event) => onResultClick(event, hit)}
                      {...palette.getItemProps(i)}
                    >
                      <span className="lesto-cmdk-item-title">{hit.title}</span>
                      <span className="lesto-cmdk-item-snippet">{hit.snippet}</span>
                    </a>
                  </li>
                ))
              )}
            </ul>
            <div className="lesto-cmdk-footer" aria-hidden="true">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> navigate
              </span>
              <span>
                <kbd>↵</kbd> open
              </span>
              <span>
                <kbd>esc</kbd> close
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

// ============================================================================
// Default styles
// ============================================================================

// The stylesheet lives in a React-free sibling module so a no-React consumer
// (e.g. a fully-static edge Worker) can import the look without bundling React.
// Re-exported here so `@lesto/content-search/react` remains the one-stop import.
export { commandPaletteStyles } from "./command-palette-styles";

export default CommandPalette;
