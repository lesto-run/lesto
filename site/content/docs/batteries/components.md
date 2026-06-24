---
title: UI components
description: A scaffolded Lesto app is a generic shadcn/ui project — components.json, path aliases, cn(), and the v4 OKLCH theme are wired, so npx shadcn add just works.
section: Batteries
order: 26
---

# UI components

Lesto does not ship its own component library. Instead, a scaffolded Lesto app is set
up as a **generic [shadcn/ui](https://ui.shadcn.com) project** — so you copy in the
same components the rest of the ecosystem uses, own the code, and style them with the
[Tailwind pipeline](/batteries/styling) Lesto already compiles.

shadcn is not an npm dependency; it is a CLI that copies component source into your
project. It works against any project that has four things, and `npm create lesto`
scaffolds all four:

1. **`components.json`** — `style: "new-york"`, `baseColor: "neutral"`, CSS variables
   on, `iconLibrary: "lucide"`, and `aliases` pointing at `@/components`,
   `@/components/ui`, `@/lib/utils`, `@/lib`, and `@/hooks`.
2. **Path aliases** — `tsconfig.json` maps `@/*` to `./app/*`, so the aliases resolve
   and components land under `app/components/ui`.
3. **A Tailwind v4 CSS entry** — `app/styles/app.css` (see [Styling](/batteries/styling)),
   which ships the shadcn `neutral` OKLCH theme: `@import "tailwindcss"`,
   `@import "tw-animate-css"`, `@custom-variant dark`, and the `:root` / `.dark` token
   sets `@theme inline` exposes as utilities.
4. **`cn()`** — `app/lib/utils.ts` exports the `clsx` + `tailwind-merge` helper every
   shadcn component imports as `@/lib/utils`.

## Adding a component

In a scaffolded app, run the shadcn CLI:

```sh
npx shadcn@latest add button card badge
```

Each component is written into `app/components/ui/`, imports `cn` from `@/lib/utils`,
and is themed by your OKLCH tokens. Use it like any component:

```tsx title="app/routes/page.tsx"
import { Button } from "@/components/ui/button";

export default {
  component: () => (
    <main className="p-8">
      <Button>Get started</Button>
    </main>
  ),
};
```

Static, presentational components — Button, Card, Badge, and the like — render on the
server with no extra work.

## Interactive components are islands

The one Lesto-specific wrinkle: shadcn's interactive primitives (Dialog, DropdownMenu,
Popover, Sheet, Sonner, …) are React **client** components, and Lesto's client
interactivity is [islands](/concepts). So after adding one, wrap it as a `defineIsland`
so it hydrates on the client:

```tsx title="app/islands/confirm-dialog.tsx"
import { defineIsland } from "@lesto/ui";

import {
  Dialog,
  DialogContent,
  DialogTrigger,
} from "@/components/ui/dialog";

function ConfirmDialog(): JSX.Element {
  return (
    <Dialog>
      <DialogTrigger className="underline">Open</DialogTrigger>
      <DialogContent data-slot="dialog-content">Are you sure?</DialogContent>
    </Dialog>
  );
}

export default defineIsland({ name: "ConfirmDialog", component: ConfirmDialog });
```

Preserve each primitive's `data-slot` attribute when you wrap it — shadcn's styles key
off it. The static primitives need no wrapper; only the interactive ones do.

> [!NOTE]
> Two conveniences are on the way and **not shipped yet**: a `lesto add` command that
> delegates to `shadcn add` and **auto-wraps** the interactive primitives as islands
> for you, and a hosted **`@lesto` registry** of island-aware, Workers-safe components
> installable through the shadcn MCP server. Until then, use `npx shadcn add` and wrap
> interactive primitives by hand as shown above.

## Theming

The colors live as OKLCH tokens in `app/styles/app.css` — edit them by hand, or use a
theme generator and paste the `:root` / `.dark` block back in. Because the tokens are
plain CSS variables exposed through `@theme inline`, recoloring the whole app (and its
shadcn components) is a single block, and dark mode is a `.dark` class on `<html>`.

## See also

- [Styling](/batteries/styling) — the Tailwind v4 pipeline that compiles the theme and
  every component's utilities.
- [Concepts](/concepts) — how islands hydrate the interactive components on the client.
