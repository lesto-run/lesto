/**
 * The estate design system's stylesheet — one inline `<style>` the layout emits.
 *
 * Kept as a string the {@link EstateLayout} renders at the top of `<body>` (not a
 * linked file) so a prerendered marketing page is a single self-contained
 * document with no extra round-trip, and the dynamic `/mls` page shares the
 * identical rules from the same source. Interactive controls are sized for touch
 * (≥44px tall with real padding) so adjacent nav links and form buttons clear
 * Lighthouse's tap-target audit instead of being thin inline text.
 *
 * This is the playground's whole visual language: the layout tokens below, the
 * components in `components.tsx`, and the `/styleguide` page that showcases them
 * all read from these class names.
 */
export const ESTATE_CSS = `
  :root {
    --ink: #1a1a1a;
    --muted: #555;
    --line: #eee;
    --accent: #1f6feb;
    font-family: ui-sans-serif, system-ui, sans-serif;
    color: var(--ink);
  }
  body { margin: 0; }
  a { color: inherit; }
  .site { display: flex; align-items: center; justify-content: space-between;
          padding: 1rem 2rem; border-bottom: 1px solid var(--line); }
  .site__brand { font-weight: 700; text-decoration: none; color: inherit;
          display: inline-flex; align-items: center; min-height: 44px; }
  .site__nav { display: flex; align-items: center; gap: .5rem; }
  .site__nav a { display: inline-flex; align-items: center; min-height: 44px;
          padding: 0 .5rem; text-decoration: none; color: var(--muted); }
  .account { margin-left: .5rem; }
  .hero { padding: 3rem 2rem; }
  .hero h1 { font-size: 2.25rem; margin: 0 0 .5rem; }
  .copy { padding: 0 2rem 2rem; max-width: 60ch; color: var(--muted); }
  .grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          padding: 0 2rem 3rem; }
  .card { border: 1px solid var(--line); border-radius: 12px; padding: 1.25rem; }
  .card h2 { font-size: 1.1rem; margin: 0 0 .5rem; }
  .card__price { font-weight: 700; }
  .auth button { min-height: 44px; padding: 0 1rem; }
  .auth input { min-height: 44px; padding: 0 .5rem; }

  /* Style-guide + playground primitives. */
  .swatch { display: inline-block; width: 4rem; height: 4rem; border-radius: 8px;
            border: 1px solid var(--line); vertical-align: middle; margin-right: .5rem; }
  .badge { display: inline-block; padding: .15rem .6rem; border-radius: 999px;
           background: var(--line); font-size: .8rem; }
  .button { display: inline-flex; align-items: center; min-height: 44px; padding: 0 1rem;
            border-radius: 8px; border: 1px solid var(--accent); background: var(--accent);
            color: #fff; text-decoration: none; cursor: pointer; }
  .button--ghost { background: transparent; color: var(--accent); }
  .section { padding: 1.5rem 2rem; border-bottom: 1px solid var(--line); }
  .section h2 { margin-top: 0; }
`;
