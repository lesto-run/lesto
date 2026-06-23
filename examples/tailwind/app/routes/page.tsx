import type { ReactNode } from "react";

import type { PageDef } from "@lesto/web";

/**
 * The home page, styled entirely with Tailwind utilities. Every class here is a
 * COMPLETE static string the oxide scanner can see — `bg-brand` resolves to the
 * `--color-brand` `@theme` token in `app/styles/app.css`, proving a custom token
 * round-trips through the build. If `out/styles.css` is missing or wrong, this page
 * renders unstyled — the visible failure the QA gate guards against.
 */
const page: PageDef<"/"> = {
  component: (): ReactNode => (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <span className="inline-block rounded-full bg-brand px-3 py-1 text-sm font-medium text-white">
        Tailwind v4
      </span>

      <h1 className="mt-6 text-4xl font-bold tracking-tight text-brand">Styled by Lesto</h1>

      <p className="mt-4 text-lg leading-relaxed text-gray-600">
        This page is compiled by <code className="rounded bg-gray-100 px-1.5 py-0.5">@lesto/styles</code>{" "}
        — <code className="rounded bg-gray-100 px-1.5 py-0.5">ui.css</code> became{" "}
        <code className="rounded bg-gray-100 px-1.5 py-0.5">out/styles.css</code>, linked here via{" "}
        <code className="rounded bg-gray-100 px-1.5 py-0.5">.styles()</code>.
      </p>
    </main>
  ),

  metadata: () => ({
    title: "Styled by Lesto",
    description: "A Lesto page compiled with first-class Tailwind v4 (ADR 0037).",
  }),
};

export default page;
