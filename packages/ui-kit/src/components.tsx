/**
 * The vetted starter kit: ~ten components, each a `ComponentDef` the AI can
 * compose into a UI tree. The engine (@keel/ui) validates and renders these;
 * this file owns only the vocabulary and the look.
 *
 * Every component draws exclusively from the shared design `tokens`, uses inline
 * styles (no stylesheet to load, no class names to leak), and declares its
 * `children` policy honestly: `false` for a leaf, `true` for a container. A
 * component's `render` receives an already-validated prop bag — enum values are
 * guaranteed in range, required props guaranteed present — so the renders read
 * as pure prop-to-markup transforms with no defensive noise.
 */

import type { ComponentDef } from "@keel/ui";
import type { CSSProperties } from "react";

import { tokens } from "./tokens";

/** The root frame of a page: full-bleed background, comfortable padding. */
export const Page: ComponentDef = {
  name: "Page",
  description: "The outermost page frame.",
  props: {},
  children: true,
  render: (_props, children) => {
    const style: CSSProperties = {
      fontFamily: tokens.font.family,
      color: tokens.color.text,
      background: tokens.color.background,
      padding: tokens.space[5],
      minHeight: "100%",
    };

    return <div style={style}>{children}</div>;
  },
};

/** A titled band of content; a vertical breath between sections. */
export const Section: ComponentDef = {
  name: "Section",
  description: "A standalone band of content within a page.",
  props: {},
  children: true,
  render: (_props, children) => {
    const style: CSSProperties = {
      marginBottom: tokens.space[5],
    };

    return <section style={style}>{children}</section>;
  },
};

/** Lay children out in a line — vertical or horizontal — with a uniform gap. */
export const Stack: ComponentDef = {
  name: "Stack",
  description: "Lays its children out in a single direction with a uniform gap.",
  props: {
    direction: {
      type: "enum",
      values: ["vertical", "horizontal"],
      default: "vertical",
      description: "Flow axis of the children.",
    },
    gap: {
      type: "number",
      default: 2,
      description: "Index into the spacing scale for the space between children.",
    },
  },
  children: true,
  render: (props, children) => {
    const direction = props["direction"] as "vertical" | "horizontal";

    // Coerce to a finite number before it ever touches a style string: a prop
    // that arrived as NaN/Infinity or a CSS-bearing string falls back to the
    // declared default rather than being interpolated verbatim.
    const gap = numericProp(props["gap"], 2);

    const style: CSSProperties = {
      display: "flex",
      flexDirection: direction === "horizontal" ? "row" : "column",
      gap: gapPx(gap),
    };

    return <div style={style}>{children}</div>;
  },
};

/** A simple N-column grid; children flow into equal-width tracks. */
export const Grid: ComponentDef = {
  name: "Grid",
  description: "Arranges its children into an N-column grid.",
  props: {
    columns: {
      type: "number",
      default: 2,
      description: "Number of equal-width columns.",
    },
  },
  children: true,
  render: (props, children) => {
    // `columns` is interpolated into a CSS grid-template string, so it must be a
    // real finite number — never an attacker-shaped string that could smuggle
    // extra CSS through the template. A non-number falls back to the default.
    const columns = numericProp(props["columns"], 2);

    const style: CSSProperties = {
      display: "grid",
      gridTemplateColumns: `repeat(${columns}, 1fr)`,
      gap: tokens.space[4],
    };

    return <div style={style}>{children}</div>;
  },
};

/** A bordered, padded surface that visually groups its children. */
export const Card: ComponentDef = {
  name: "Card",
  description: "A bordered, padded surface grouping related content.",
  props: {},
  children: true,
  render: (_props, children) => {
    const style: CSSProperties = {
      background: tokens.color.surface,
      border: `1px solid ${tokens.color.border}`,
      borderRadius: tokens.radius.md,
      padding: tokens.space[4],
    };

    return <div style={style}>{children}</div>;
  },
};

/** A section heading at one of four levels; a leaf carrying its own text. */
export const Heading: ComponentDef = {
  name: "Heading",
  description: "A heading at one of four levels.",
  props: {
    text: {
      type: "string",
      required: true,
      description: "The heading text.",
    },
    level: {
      type: "enum",
      values: ["1", "2", "3", "4"],
      default: "2",
      description: "Heading level, 1 (largest) through 4.",
    },
  },
  children: false,
  render: (props) => {
    const text = props["text"] as string;

    // The validated enum is the string form of the level; index the size ramp
    // and the tag name off the same numeric level.
    const level = Number(props["level"] as "1" | "2" | "3" | "4");

    const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4";

    const style: CSSProperties = {
      margin: 0,
      fontSize: tokens.font.headingSize[level],
      fontWeight: 600,
      color: tokens.color.text,
    };

    return <Tag style={style}>{text}</Tag>;
  },
};

/** A run of body text, in the default tone or a muted secondary tone. */
export const Text: ComponentDef = {
  name: "Text",
  description: "A paragraph of body text.",
  props: {
    text: {
      type: "string",
      required: true,
      description: "The text to display.",
    },
    tone: {
      type: "enum",
      values: ["default", "muted"],
      default: "default",
      description: "Emphasis: full-strength or muted.",
    },
  },
  children: false,
  render: (props) => {
    const text = props["text"] as string;

    const tone = props["tone"] as "default" | "muted";

    const style: CSSProperties = {
      margin: 0,
      fontSize: tokens.font.bodySize,
      color: tone === "muted" ? tokens.color.muted : tokens.color.text,
    };

    return <p style={style}>{text}</p>;
  },
};

/** An action: a link when `href` is present, otherwise a plain button. */
export const Button: ComponentDef = {
  name: "Button",
  description: "A call to action; renders as a link when given an href.",
  props: {
    label: {
      type: "string",
      required: true,
      description: "The button's visible text.",
    },
    variant: {
      type: "enum",
      values: ["primary", "secondary", "ghost"],
      default: "primary",
      description: "Visual weight of the action.",
    },
    href: {
      type: "string",
      description: "If set, the button is a link to this URL.",
    },
  },
  children: false,
  render: (props) => {
    const label = props["label"] as string;

    const variant = props["variant"] as "primary" | "secondary" | "ghost";

    const href = props["href"];

    const style = buttonStyle(variant);

    // A link target turns the action into an anchor; without one it's a button.
    if (typeof href === "string") {
      return (
        <a href={href} style={style}>
          {label}
        </a>
      );
    }

    return (
      <button type="button" style={style}>
        {label}
      </button>
    );
  },
};

/** A small pill that labels or tags a thing. A leaf. */
export const Badge: ComponentDef = {
  name: "Badge",
  description: "A small pill that labels or categorizes.",
  props: {
    text: {
      type: "string",
      required: true,
      description: "The badge text.",
    },
  },
  children: false,
  render: (props) => {
    const text = props["text"] as string;

    const style: CSSProperties = {
      display: "inline-block",
      padding: `${tokens.space[1]}px ${tokens.space[2]}px`,
      borderRadius: tokens.radius.sm,
      background: tokens.color.secondary,
      color: tokens.color.secondaryText,
      fontSize: "12px",
      fontWeight: 600,
    };

    return <span style={style}>{text}</span>;
  },
};

/** A horizontal rule separating content. No props, no children. */
export const Divider: ComponentDef = {
  name: "Divider",
  description: "A horizontal rule between sections of content.",
  props: {},
  children: false,
  render: () => {
    const style: CSSProperties = {
      border: "none",
      borderTop: `1px solid ${tokens.color.border}`,
      margin: `${tokens.space[3]}px 0`,
    };

    return <hr style={style} />;
  },
};

/** Every component the kit ships, in declaration order. */
export const kitComponents: readonly ComponentDef[] = [
  Page,
  Section,
  Stack,
  Grid,
  Card,
  Heading,
  Text,
  Button,
  Badge,
  Divider,
];

/**
 * Coerce a numeric prop to a real finite number before it reaches a style.
 *
 * The prop validator coerces numeric *strings* to numbers but, by design, lets
 * anything it can't coerce pass through unchanged — so a value shaped to inject
 * CSS (a string carrying `)` and extra declarations, or a non-finite NaN/
 * Infinity) can still arrive here. We never interpolate such a value: only a
 * genuine finite number survives; everything else collapses to `fallback`.
 */
function numericProp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Resolve a spacing-scale index to a CSS pixel string. */
function gapPx(index: number): string {
  // Guard the scale's bounds: an out-of-range index falls back to no gap rather
  // than emitting `undefinedpx`.
  const value = tokens.space[index] ?? 0;

  return `${value}px`;
}

/** The base + variant styling for an action, shared by link and button forms. */
function buttonStyle(variant: "primary" | "secondary" | "ghost"): CSSProperties {
  const base: CSSProperties = {
    display: "inline-block",
    padding: `${tokens.space[2]}px ${tokens.space[4]}px`,
    borderRadius: tokens.radius.sm,
    fontSize: tokens.font.bodySize,
    fontWeight: 600,
    textDecoration: "none",
    cursor: "pointer",
  };

  if (variant === "primary") {
    return {
      ...base,
      background: tokens.color.primary,
      color: tokens.color.primaryText,
      border: `1px solid ${tokens.color.primary}`,
    };
  }

  if (variant === "secondary") {
    return {
      ...base,
      background: tokens.color.secondary,
      color: tokens.color.secondaryText,
      border: `1px solid ${tokens.color.border}`,
    };
  }

  // ghost: no fill, no border — just the primary color as text.
  return {
    ...base,
    background: "transparent",
    color: tokens.color.primary,
    border: "1px solid transparent",
  };
}
