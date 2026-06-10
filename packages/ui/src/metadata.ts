/**
 * Document metadata — `<title>`, `<meta>`, `<link>` — that any component may
 * render, anywhere in the tree.
 *
 * React 19 hoists these tags out of the body and into the document head during
 * SSR (and under the framework's buffered `renderToStaticMarkup`, to the front of
 * the emitted markup). So a deeply nested component can declare the page's title
 * or description and React floats it up — no prop-drilling a metadata bag to the
 * document shell.
 *
 * The catch React leaves to the framework: **React hoists but does not dedupe.**
 * Two components that each render a `<title>` ship two `<title>` tags, and the
 * browser honors the first — a silent footgun. A page has exactly one title and
 * one canonical link; many `<meta name>` are singletons too. So this module pairs
 * the thin element helpers with {@link dedupeMetadata}, a pure pass the document
 * shell runs over collected metadata to keep the last value per logical key.
 *
 * The helpers return plain React elements; nothing here renders or touches the
 * DOM. `dedupeMetadata` is pure data-in/data-out so it is fully testable without
 * React at all.
 */

import { createElement } from "react";
import type { ReactElement } from "react";

/** Render `<title>{text}</title>`. A page should resolve to exactly one. */
export function title(text: string): ReactElement {
  return createElement("title", null, text);
}

/** A `<meta name=… content=…>` tag (description, theme-color, robots, …). */
export interface NamedMeta {
  name: string;
  content: string;
}

/** A `<meta property=… content=…>` tag (Open Graph / `og:` namespace). */
export interface PropertyMeta {
  property: string;
  content: string;
}

/** A `<meta charset>` tag — the one meta that must come first in the head. */
export interface CharsetMeta {
  charSet: string;
}

/** Any meta tag this module knows how to render and dedupe. */
export type MetaSpec = NamedMeta | PropertyMeta | CharsetMeta;

/** A `<link>` tag — canonical, alternate, icon, preconnect authored by hand, … */
export interface LinkSpec {
  rel: string;
  href: string;
  hrefLang?: string;
  type?: string;
  sizes?: string;
  media?: string;
}

/** Render a `<meta>` from any {@link MetaSpec}. */
export function meta(spec: MetaSpec): ReactElement {
  return createElement("meta", { ...spec });
}

/**
 * Render a `<link>` from a {@link LinkSpec}, dropping absent optionals. An
 * optional `key` is stamped for use inside a sibling list (see {@link renderMetadata}).
 */
export function link(spec: LinkSpec, key?: string): ReactElement {
  return createElement("link", {
    ...(key === undefined ? {} : { key }),
    rel: spec.rel,
    href: spec.href,
    ...(spec.hrefLang === undefined ? {} : { hrefLang: spec.hrefLang }),
    ...(spec.type === undefined ? {} : { type: spec.type }),
    ...(spec.sizes === undefined ? {} : { sizes: spec.sizes }),
    ...(spec.media === undefined ? {} : { media: spec.media }),
  });
}

/**
 * A single declared piece of metadata before it is rendered or deduped. Keeping
 * metadata as data (not elements) until the last moment is what lets the document
 * shell dedupe it — you cannot inspect a built React element's identity cheaply.
 */
export type MetadataEntry =
  | { kind: "title"; text: string }
  | { kind: "meta"; spec: MetaSpec }
  | { kind: "link"; spec: LinkSpec };

/** The dedupe key charset entries collapse to — also the key we promote first. */
const CHARSET_KEY = "meta:charset";

/**
 * The logical identity of a metadata entry — entries sharing a key are the "same"
 * tag, and the LAST one wins. This encodes the de-facto HTML singletons:
 *   - a page has one `<title>`;
 *   - one `<meta charset>`;
 *   - one `<meta name="x">` per name, one `<meta property="og:y">` per property;
 *   - one `<link rel="canonical">` (rel alone), but MANY `<link rel="alternate">`
 *     (keyed by rel+href+hrefLang, so hreflang variants and icon sizes coexist).
 */
function dedupeKey(entry: MetadataEntry): string {
  if (entry.kind === "title") return "title";

  if (entry.kind === "meta") return metaKey(entry.spec);

  return linkKey(entry.spec);
}

/** The dedupe key for a meta entry: charset, name, or og-property are singletons. */
function metaKey(spec: MetaSpec): string {
  if ("charSet" in spec) return CHARSET_KEY;

  if ("name" in spec) return `meta:name:${spec.name}`;

  return `meta:property:${spec.property}`;
}

/**
 * The dedupe key for a link entry. `rel="canonical"` is a true singleton (keyed by
 * rel alone). Everything else — stylesheets, icons, alternates, preloads — may
 * legitimately repeat, so it is keyed by rel+href+hrefLang and only an exact
 * duplicate collapses.
 */
function linkKey(spec: LinkSpec): string {
  if (spec.rel === "canonical") return "link:canonical";

  return `link:${spec.rel}:${spec.href}:${spec.hrefLang ?? ""}`;
}

/**
 * Collapse a metadata list so each logical key appears once, keeping the LAST
 * occurrence (a nested component's value overrides a layout's default) while
 * preserving the order in which surviving keys first appeared.
 *
 * One position is NOT first-seen: `<meta charset>` is hoisted to the FRONT
 * regardless of where it was declared. The HTML spec requires the charset
 * declaration within the first 1024 bytes of the document and ideally first;
 * since any component may declare it from deep in the tree, a first-seen order
 * would let a late declaration sit after other hoisted tags and miss that window.
 * Promoting it is mechanical and safe — charset is a singleton, so there is only
 * ever one to move.
 *
 * Pure: same input, same output; no React, no DOM. The document shell runs this
 * before rendering the entries, so duplicate `<title>`s never ship — closing the
 * gap React's hoist-without-dedupe leaves open.
 */
export function dedupeMetadata(entries: readonly MetadataEntry[]): MetadataEntry[] {
  // First appearance fixes order; last value wins. We record both, then emit in
  // first-seen order with the winning value — stable and intention-revealing.
  const order: string[] = [];

  const winner = new Map<string, MetadataEntry>();

  for (const entry of entries) {
    const key = dedupeKey(entry);

    if (!winner.has(key)) order.push(key);

    winner.set(key, entry);
  }

  // Charset must lead the head, so pull it out of its first-seen slot and emit it
  // first. Everything else keeps first-seen order behind it.
  const charsetFirst = winner.has(CHARSET_KEY)
    ? [CHARSET_KEY, ...order.filter((key) => key !== CHARSET_KEY)]
    : order;

  // Surviving entries in (charset-first) order, each with its winning value.
  return charsetFirst.map((key) => winner.get(key) as MetadataEntry);
}

/**
 * Render one {@link MetadataEntry} to its React element, stamping `key` so the
 * element can sit in a sibling list without a missing-key warning. The key flows
 * into the element config alongside the tag's own attributes.
 */
export function renderMetadataEntry(entry: MetadataEntry, key: string): ReactElement {
  if (entry.kind === "title") return createElement("title", { key }, entry.text);

  if (entry.kind === "meta") return createElement("meta", { key, ...entry.spec });

  return link(entry.spec, key);
}

/**
 * Dedupe then render a metadata list into React elements, each keyed by its
 * first-seen index so React places the siblings cleanly. Drop this array into the
 * tree and React hoists every tag into the head.
 */
export function renderMetadata(entries: readonly MetadataEntry[]): ReactElement[] {
  return dedupeMetadata(entries).map((entry, index) => renderMetadataEntry(entry, `m${index}`));
}
