/**
 * The docs search box — the site's one interactive island.
 *
 * It is a DEFERRED island (`ssr: false`): the server renders the static input
 * `fallback`, and the preact client bundle mounts the real {@link SearchBox}
 * fresh on load (the scaffold's default pairing — React-rendered pages, a small
 * preact client, no hydration of server markup). On mount the box fetches the
 * prerendered `/search-index.json` and, as the user types, runs
 * `@lesto/content-search`'s keyword `keywordSearch` over it entirely in the
 * browser — no server, no model. Results link straight to the matching page.
 */

import { keywordSearch } from "@lesto/content-search";
import type { SearchResult } from "@lesto/content-search";
import { defineIsland } from "@lesto/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";

import type { SearchIndex } from "../../src/search-index";

const RESULT_LIMIT = 8;

function SearchBox(): ReactElement {
  const [index, setIndex] = useState<SearchIndex | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetch("/search-index.json");
        const loaded = (await response.json()) as SearchIndex;
        if (live) setIndex(loaded);
      } catch {
        // Search degrades to absent if the index can't load; the page still works.
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const results = useMemo<SearchResult[]>(() => {
    if (index === null || query.trim() === "") return [];
    return keywordSearch(query, index, { limit: RESULT_LIMIT });
  }, [index, query]);

  const showResults = open && query.trim() !== "";

  return (
    <div className="docs-search" role="search">
      <input
        className="docs-search-input"
        type="search"
        placeholder="Search docs…"
        aria-label="Search documentation"
        value={query}
        disabled={index === null}
        onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Delay so a click on a result registers before the list unmounts.
          blurTimer.current = setTimeout(() => setOpen(false), 150);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setQuery("");
        }}
      />
      {showResults ? (
        <ul className="docs-search-results">
          {results.length === 0 ? (
            <li className="docs-search-empty">No matches</li>
          ) : (
            results.map((result) => (
              <li key={result.id}>
                <a href={result.slug}>
                  <span className="docs-search-title">{result.title}</span>
                  <span className="docs-search-snippet">{result.snippet}</span>
                </a>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

/** The server-rendered placeholder, shown until the client bundle mounts the box. */
function SearchFallback(): ReactElement {
  return (
    <div className="docs-search" role="search">
      <input
        className="docs-search-input"
        type="search"
        placeholder="Search docs…"
        aria-label="Search documentation"
        disabled
      />
    </div>
  );
}

export default defineIsland({
  name: "Search",
  component: SearchBox,
  fallback: SearchFallback,
});
