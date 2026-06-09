/**
 * The design tokens: the single source of truth for the kit's visual language.
 *
 * Every component reaches into this one object for color, spacing, type, and
 * radius — so the whole kit moves together when a token changes, and the AI
 * never has to invent a hex code or a pixel value. Frozen so a component can
 * read tokens but never mutate the shared palette out from under its siblings.
 */

export const tokens = Object.freeze({
  color: Object.freeze({
    text: "#1a1a1a",
    muted: "#6b7280",
    background: "#ffffff",
    surface: "#f9fafb",
    border: "#e5e7eb",
    primary: "#2563eb",
    primaryText: "#ffffff",
    secondary: "#e5e7eb",
    secondaryText: "#1a1a1a",
  }),

  // Spacing scale, in pixels — a small geometric-ish ramp the layout
  // components index into so gaps and padding stay on a shared rhythm.
  space: Object.freeze([0, 4, 8, 16, 24, 32, 48]),

  radius: Object.freeze({
    sm: "4px",
    md: "8px",
  }),

  font: Object.freeze({
    family: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
    // Heading sizes indexed by level: index 0 is unused so level 1..4 reads
    // directly as `headingSize[level]`.
    headingSize: Object.freeze(["", "32px", "24px", "20px", "16px"]),
    bodySize: "16px",
  }),
});

/** The shape of the frozen design-token object, for typed consumers. */
export type Tokens = typeof tokens;
