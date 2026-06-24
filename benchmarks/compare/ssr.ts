/**
 * The SSR-render comparison: render the SAME element tree to the SAME HTML string
 * through several server-render paths and time each.
 *
 *   - `react`          — `react-dom/server`'s `renderToStaticMarkup`.
 *   - `preact`         — `preact-render-to-string`'s `renderToString`.
 *   - `lesto-registry` — Lesto's `renderPage` → `renderPageMarkup`, the JSON-driven
 *                        UI path that walks a registry and VALIDATES every node's
 *                        props on each render. This is the genuinely Lesto-specific
 *                        render path; the number shows its registry+validation cost
 *                        over the raw renderer it sits on.
 *
 * Note there is deliberately NO bare "lesto" render row: Lesto's plain-component
 * renderer (`reactServerRenderer.renderToStaticMarkup`) IS `react-dom/server`'s
 * `renderToStaticMarkup` (a thin dialect seam, not a fork), so a "lesto" row would
 * time the exact same function as the `react` row — a tautology, not a measurement.
 * A plain Lesto `.page` therefore renders at React's speed by construction; the only
 * Lesto-specific cost worth measuring is the registry/page path above.
 *
 * Every path emits byte-identical markup (asserted in `ssr.test.ts`), so the only
 * variable is the render path. To stay fair, each path REBUILDS its element tree
 * per call — `renderPage` reconstructs its element tree from the plain tree spec on
 * every render, and a real component's JSX re-evaluates per render too, so none of
 * the contenders gets to amortize construction the others can't.
 */

import { createElement as reactEl } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { h as preactEl } from "preact";
import { renderToString as preactRenderToString } from "preact-render-to-string";

import { Registry } from "@lesto/ui";
import { renderPage, renderPageMarkup } from "@lesto/ui/server";

import type { SampleSource } from "@lesto/bench";
import type { ComponentDef } from "@lesto/ui";

/** The size of the rendered list. Big enough to dwarf per-call fixed costs, small enough to stay in cache. */
export const DEFAULT_SSR_ROWS = 50;

/** The labels for each cell, fixed up front so the render loop allocates nothing it can avoid. */
function rowLabels(rows: number): string[] {
  return Array.from({ length: rows }, (_, i) => `item ${i}`);
}

/** Build the React element tree for the row list (rebuilt per render, like real JSX). */
function reactTree(rows: number): ReturnType<typeof reactEl> {
  return reactEl(
    "div",
    { className: "box" },
    rowLabels(rows).map((label, i) =>
      reactEl("div", { className: "row", key: i }, reactEl("span", { className: "cell" }, label)),
    ),
  );
}

/** Build the Preact element tree for the row list. */
function preactTree(rows: number): ReturnType<typeof preactEl> {
  return preactEl(
    "div",
    { className: "box" },
    rowLabels(rows).map((label, i) =>
      preactEl("div", { className: "row", key: i }, preactEl("span", { className: "cell" }, label)),
    ),
  );
}

/** Build the Lesto registry + plain tree spec (the JSON-driven UI path). */
function lestoRegistry(rows: number): { registry: Registry; tree: unknown } {
  const Box: ComponentDef = {
    name: "Box",
    props: {},
    children: true,
    render: (_props, children) => reactEl("div", { className: "box" }, children),
  };
  const Row: ComponentDef = {
    name: "Row",
    props: { label: { type: "string", required: true } },
    children: false,
    render: (props) =>
      reactEl(
        "div",
        { className: "row" },
        reactEl("span", { className: "cell" }, props.label as string),
      ),
  };

  const registry = new Registry().define(Box).define(Row);
  const tree = {
    type: "Box",
    children: rowLabels(rows).map((label) => ({ type: "Row", props: { label } })),
  };

  return { registry, tree };
}

/** Render the row list through raw `react-dom/server`. */
export function renderReactSsr(rows = DEFAULT_SSR_ROWS): string {
  return renderToStaticMarkup(reactTree(rows));
}

/** Render the row list through `preact-render-to-string`. */
export function renderPreactSsr(rows = DEFAULT_SSR_ROWS): string {
  return preactRenderToString(preactTree(rows));
}

/** Render the row list through Lesto's validated registry-tree path. */
export function renderLestoRegistrySsr(rows = DEFAULT_SSR_ROWS): string {
  const { registry, tree } = lestoRegistry(rows);

  return renderPageMarkup(renderPage(registry, tree));
}

/** A React SSR sample. */
export function reactSsrSample(rows = DEFAULT_SSR_ROWS): SampleSource {
  return async () => {
    renderReactSsr(rows);
  };
}

/** A Preact SSR sample. */
export function preactSsrSample(rows = DEFAULT_SSR_ROWS): SampleSource {
  return async () => {
    renderPreactSsr(rows);
  };
}

/** A Lesto registry-tree sample (the validated JSON-driven UI path). */
export function lestoRegistrySsrSample(rows = DEFAULT_SSR_ROWS): SampleSource {
  // Build the fixture once; the registry/tree is reused, only the render walk repeats.
  const { registry, tree } = lestoRegistry(rows);

  return async () => {
    renderPageMarkup(renderPage(registry, tree));
  };
}

/**
 * The exact markup every path must produce, for the equivalence assertion in the
 * test. Kept here next to the renderers so a change to the tree updates the oracle
 * in one place.
 */
export function expectedSsrMarkup(rows = DEFAULT_SSR_ROWS): string {
  const cells = rowLabels(rows)
    .map((label) => `<div class="row"><span class="cell">${label}</span></div>`)
    .join("");

  return `<div class="box">${cells}</div>`;
}
