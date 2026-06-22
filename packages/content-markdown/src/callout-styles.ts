/**
 * Drop-in stylesheet for {@link rehypeCallouts} output.
 *
 * A plain string importing nothing, so it can be inlined during a static
 * prerender or concatenated into any stylesheet without a CSS pipeline. Each
 * type's accent reads from a CSS custom property (`--callout-note`, …) with a
 * sensible fallback, so a host theme can recolor callouts without forking this.
 * The neutral surfaces read the shared `--callout-surface` / `--callout-fg`
 * vars (falling back to transparent-tinted accents) so callouts sit correctly
 * on both light and dark backgrounds.
 */
export const calloutStyles = `
.lesto-callout {
  --_accent: var(--callout-note, #3b82f6);
  margin: 1.25rem 0;
  padding: 0.85rem 1rem;
  border: 1px solid color-mix(in srgb, var(--_accent) 30%, transparent);
  border-left: 3px solid var(--_accent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--_accent) 7%, transparent);
}
.lesto-callout > :first-child { margin-top: 0; }
.lesto-callout > :last-child { margin-bottom: 0; }
.lesto-callout-note { --_accent: var(--callout-note, #3b82f6); }
.lesto-callout-tip { --_accent: var(--callout-tip, #10b981); }
.lesto-callout-important { --_accent: var(--callout-important, #8b5cf6); }
.lesto-callout-warning { --_accent: var(--callout-warning, #f59e0b); }
.lesto-callout-caution { --_accent: var(--callout-caution, #ef4444); }
.lesto-callout-title {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  margin: 0 0 0.4rem;
  font-weight: 600;
  font-size: 0.92rem;
  line-height: 1.3;
  color: var(--_accent);
  letter-spacing: 0.01em;
}
.lesto-callout-icon {
  display: inline-flex;
  font-size: 0.95rem;
  line-height: 1;
}
`;
