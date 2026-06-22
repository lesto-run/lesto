/**
 * Drop-in stylesheet for {@link rehypePackageCommands} output.
 *
 * A plain string importing nothing, so a no-React, no-pipeline consumer can
 * inline it. Colors read from the shared content vars (`--bg`, `--fg`, `--muted`,
 * `--border`, `--surface`, `--accent`) with fallbacks, so the tabs inherit a
 * host theme. Non-active panels are hidden with the native `hidden` attribute,
 * so the block collapses to the npm command with no JavaScript.
 */
export const packageCommandStyles = `
.lesto-pm-tabs {
  margin: 1.25rem 0;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 10px;
  overflow: hidden;
}
.lesto-pm-tablist {
  display: flex;
  gap: 0.25rem;
  padding: 0.3rem 0.4rem;
  background: var(--surface, #f9fafb);
  border-bottom: 1px solid var(--border, #e5e7eb);
}
.lesto-pm-tab {
  appearance: none;
  font: inherit;
  font-size: 0.85rem;
  line-height: 1.2;
  padding: 0.3rem 0.7rem;
  color: var(--muted, #6b7280);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
}
.lesto-pm-tab:hover { color: var(--fg, #1c1e21); }
.lesto-pm-tab[aria-selected="true"] {
  color: var(--accent, #4f46e5);
  background: var(--bg, #fff);
  border-color: var(--border, #e5e7eb);
  font-weight: 600;
}
.lesto-pm-tab:focus-visible {
  outline: 2px solid var(--accent, #4f46e5);
  outline-offset: 1px;
}
/* The panel's <pre> already carries the code styling; strip the panel's own box
   so the tabs read as one unit. */
.lesto-pm-panel > pre { margin: 0; border: none; border-radius: 0; }
.lesto-pm-panel[hidden] { display: none; }
`;
