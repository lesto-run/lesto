/**
 * Drop-in stylesheet for the {@link CommandPalette} component (Cmd+K).
 *
 * It is a plain string — and this module imports nothing — so it can be inlined
 * during a static prerender or concatenated into any stylesheet without pulling
 * a rendering runtime (React) into the bundle. Keeping it React-free is what lets
 * a fully-static, no-React edge Worker reuse the exact same look as the live app.
 *
 * Colors read from CSS custom properties (`--bg`, `--fg`, `--border`, `--surface`,
 * `--muted`, `--accent`, `--accent-fg`, `--mono`) with sensible fallbacks, so the
 * palette inherits a host theme (including dark mode) when those vars are defined.
 */
export const commandPaletteStyles = `
.lesto-cmdk-trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.7rem;
  font: inherit;
  font-size: 0.9rem;
  color: var(--muted, #6b7280);
  background: var(--surface, #f9fafb);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  cursor: pointer;
}
.lesto-cmdk-trigger:hover { border-color: var(--accent, #4f46e5); }
.lesto-cmdk-trigger-icon { font-size: 1rem; line-height: 1; }
.lesto-cmdk-trigger-label { min-width: 7ch; text-align: left; }
.lesto-cmdk-kbd, .lesto-cmdk-footer kbd {
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 0.72rem;
  line-height: 1;
  padding: 0.15rem 0.35rem;
  color: var(--muted, #6b7280);
  background: var(--bg, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 5px;
}
.lesto-cmdk-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 12vh 1rem 1rem;
  background: rgba(10, 12, 16, 0.45);
  backdrop-filter: blur(2px);
}
.lesto-cmdk-dialog {
  width: min(640px, 100%);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 14px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.32);
}
.lesto-cmdk-input {
  flex: 0 0 auto;
  padding: 1rem 1.1rem;
  font: inherit;
  font-size: 1.05rem;
  color: var(--fg, #1c1e21);
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border, #e5e7eb);
  outline: none;
}
.lesto-cmdk-list {
  flex: 1 1 auto;
  overflow-y: auto;
  margin: 0;
  padding: 0.4rem;
  list-style: none;
}
.lesto-cmdk-group {
  flex: 0 0 auto;
  padding: 0.6rem 1.1rem 0.2rem;
  color: var(--muted, #6b7280);
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.lesto-cmdk-item { margin: 0; }
.lesto-cmdk-item-link {
  display: block;
  padding: 0.55rem 0.7rem;
  border-radius: 8px;
  color: var(--fg, #1c1e21);
  text-decoration: none;
}
.lesto-cmdk-item-link[aria-selected="true"] {
  background: var(--accent, #4f46e5);
  color: var(--accent-fg, #fff);
}
.lesto-cmdk-item-link[aria-selected="true"] .lesto-cmdk-item-snippet { color: inherit; opacity: 0.85; }
.lesto-cmdk-item-title { display: block; font-weight: 600; font-size: 0.95rem; }
.lesto-cmdk-item-snippet {
  display: block;
  margin-top: 0.1rem;
  color: var(--muted, #6b7280);
  font-size: 0.83rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lesto-cmdk-empty { padding: 1.25rem 0.9rem; color: var(--muted, #6b7280); font-size: 0.92rem; text-align: center; }
.lesto-cmdk-footer {
  flex: 0 0 auto;
  display: flex;
  gap: 1rem;
  padding: 0.5rem 0.9rem;
  color: var(--muted, #6b7280);
  font-size: 0.78rem;
  border-top: 1px solid var(--border, #e5e7eb);
}
.lesto-cmdk-footer span { display: inline-flex; align-items: center; gap: 0.3rem; }
@media (prefers-reduced-motion: reduce) {
  .lesto-cmdk-overlay { backdrop-filter: none; }
}
`;
