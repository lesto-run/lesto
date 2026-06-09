/**
 * The island's client component.
 *
 * It only renders its text once mounted in the browser, so its presence in the
 * DOM is proof that hydration ran. A `useEffect` flips a flag on mount — the
 * spec waits for "hydrated ✓" to confirm the client actually took over from the
 * server's "loading…" fallback.
 */

import { useEffect, useState } from "react";
import type { ReactElement } from "react";

export function Probe(): ReactElement {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return <span data-probe={mounted ? "hydrated" : "client-initial"}>{mounted ? "hydrated ✓" : "…"}</span>;
}
