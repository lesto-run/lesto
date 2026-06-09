/**
 * The fixture's component vocabulary — one server component and one island.
 *
 * The island's server `fallback` renders "loading…"; its real client `component`
 * renders "hydrated ✓". So the page ships "loading…", and *only if the bundle
 * runs and `hydrateIslands` mounts the component* does the DOM become
 * "hydrated ✓". That difference is what the browser spec asserts — a check no
 * server-side test can make.
 */

import { Registry } from "@keel/ui";

import { Probe } from "./probe";

export const registry = new Registry()
  .define({
    name: "Page",
    description: "A bare page shell.",
    props: {},
    children: true,
    render: (_props, children) => <main id="page">{children}</main>,
  })
  .defineClient({
    name: "Probe",
    description: "A hydration probe: 'loading…' on the server, 'hydrated ✓' on the client.",
    component: Probe,
    fallback: () => <span data-probe="fallback">loading…</span>,
  });
