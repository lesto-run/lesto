---
title: Styling
description: First-class Tailwind v4 — a CSS build that compiles app/styles/app.css to a served, hot-swapping stylesheet, with no bespoke build script.
section: Batteries
order: 26
---

# Styling

Lesto ships a first-class **Tailwind v4** CSS pipeline. Point the framework at a CSS
entry and `lesto build`/`lesto dev` compile it to a single served stylesheet — the
same way they bundle your islands into `/client.js`. There is no PostCSS config, no
bundler plugin, no bespoke build script to maintain: the CSS build is `@lesto/styles`,
a sibling of the island-client build, wired into the CLI.

A freshly scaffolded app (`npm create lesto`) comes with it already wired — a CSS
entry, the config key, the `<link>`, and the [shadcn/ui](/batteries/components) theme.
This page is what is underneath, and how to drive it in an app you already have.

## How it works

Three pieces, all conventions you can see in a scaffolded app:

1. **The CSS entry** — a Tailwind v4 stylesheet at `app/styles/app.css`. It begins
   with `@import "tailwindcss"` and holds your `@theme` tokens and any custom CSS.
   The **file's presence** is what enables the CSS build: no entry file, nothing
   compiles (Tailwind is opt-in, exactly as islands are opt-in on the presence of
   `app/islands/`).
2. **The `ui.css` config key** — optional. It renames the entry when yours lives
   somewhere other than the `app/styles/app.css` default. Its sibling
   `ui.cssScanRoot` points the class scanner somewhere other than `app/` when your
   markup lives elsewhere.
3. **The `.styles()` builder call** — links the compiled stylesheet into every page's
   `<head>`, the matched sibling of `.client()`.

```ts title="lesto.app.ts"
const config: LestoAppConfig = {
  db: handle,
  app: lesto()
    .client("/client.js") // the island runtime
    .styles("/styles.css"), // the compiled stylesheet — this page's subject
  // `css` defaults to "app/styles/app.css"; set it only to move the entry.
  ui: { dialect: "preact", css: "app/styles/app.css" },
};
```

On `lesto build`, `@lesto/styles` reads `app/styles/app.css`, scans your `app/` source
for the utility classes you actually used, runs Tailwind v4, minifies with Lightning
CSS, and writes `out/styles.css` next to `out/client.js`. On `lesto dev` it compiles on
boot and then watches your source — edit a class anywhere under `app/` and the
stylesheet **hot-swaps in place, with no full page reload**, so your island state
survives the change.

> [!NOTE]
> `@lesto/styles` is an *optional peer dependency* of the CLI, imported lazily only
> when the CSS entry file exists. An app that ships no Tailwind never pulls the
> native `@tailwindcss/*` engine — the heavy binaries stay out of the install.

## Adding it to an existing app

Install the package and the Tailwind peer, then wire the pieces above:

```package-install
npm install @lesto/styles tailwindcss
```

Create the entry:

```css title="app/styles/app.css"
@import "tailwindcss";

@theme {
  --color-brand: #4f46e5;
}
```

Add `.styles("/styles.css")` to `lesto.app.ts` (as shown above), and you are done —
`lesto dev` now serves `/styles.css` and your `className`s resolve.

## The theme

A Tailwind v4 `@theme` block defines design tokens that become **both** CSS custom
properties on `:root` **and** utilities. Declaring `--color-brand` makes `bg-brand`,
`text-brand`, and `border-brand` available everywhere:

```css title="app/styles/app.css"
@import "tailwindcss";

@theme {
  --color-brand: #4f46e5;
  --font-display: "Satoshi", sans-serif;
}
```

```tsx
<h1 className="text-brand font-display">Styled by Lesto</h1>
```

### Dark mode without variants

For a palette that swaps wholesale between light and dark, define your tokens as
`:root` variables (swapped under a media query or a `.dark` class) and map them with
`@theme inline` — so a utility resolves to the *live* variable and re-themes with no
`dark:` variant on every element. This is exactly how Lesto's own marketing and docs
sites are built:

```css title="app/styles/app.css"
:root {
  --bg: #ffffff;
  --ink: #0a0a0b;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #09090b;
    --ink: #fafafa;
  }
}

@theme inline {
  --color-bg: var(--bg);
  --color-ink: var(--ink);
}
```

Now `bg-bg text-ink` is correct in both schemes, and the swap is one block — no
`dark:` prefix anywhere. (The scaffold ships the shadcn variant instead — a `.dark`
class on `<html>` driven by `@custom-variant dark`; see
[UI components](/batteries/components).)

## The scanner gotcha

Tailwind v4 finds your utilities by scanning your `app/` source **as plain text** — it
never runs your code. So a class only ships if it appears as a **complete static
string**:

```tsx
// ✅ The scanner sees these complete strings.
<div className="bg-indigo-600 text-white" />
<div className={active ? "bg-indigo-600" : "bg-zinc-200"} />

// ❌ The scanner cannot see an interpolated class name.
<div className={`bg-${color}-600`} />
```

For classes that are genuinely assembled at runtime, safelist them with `@source
inline(...)` in your CSS so the build keeps them:

```css
@source inline("bg-red-600 bg-green-600 bg-blue-600");
```

## Production and the edge

The stylesheet ships at a **stable `/styles.css`** — a compile-time constant baked into
the worker exactly like `/client.js`, so it resolves identically under Node and on the
Cloudflare edge, which has no request-time filesystem. In production it is minified by
Lightning CSS; no serving change is needed (`.css` is already a passthrough asset, and
a Cloudflare deploy serves `out/` from Workers Assets).

> [!TIP]
> Keep the stylesheet honest about its size. If you drive the build yourself,
> `buildStyles` (the `@lesto/styles` API) accepts an optional `budgetBytes` —
> exceed it (measured gzipped) and the build fails with `STYLES_BUDGET_EXCEEDED`
> rather than silently shipping a bloated stylesheet. Without a budget it still
> reports the gzip size on every build.

## Opting out

Styling is opt-in. To ship no stylesheet, delete `app/styles/app.css` (and drop the
`.styles()` call) — with no entry file the CSS build is skipped entirely and no
`<link>` is injected.

## See also

- [UI components](/batteries/components) — a scaffolded Lesto app is a generic
  shadcn/ui project; `cn()`, `components.json`, and the OKLCH theme are already wired.
- [Concepts](/concepts) — how the `lesto()` builder, islands, and the two-tier
  (Node + edge) model fit together.
