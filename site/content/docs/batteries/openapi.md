---
title: "OpenAPI"
description: "Generate an OpenAPI 3.1 description of a Lesto app from its route list — a pure transformation with @lesto/openapi and the lesto openapi command."
section: Batteries
order: 21
---

# OpenAPI

`@lesto/openapi` turns a Lesto app's route list into an [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0)
document. The core idea is narrow on purpose: it is a pure transformation over the
`{ method, pattern }` list that `lesto().routes()` yields — no booting, no
reflection, no router coupling. Every route becomes one operation under its path,
`:param` segments become `{param}` placeholders, and internal routes are dropped
before the document is built. The result is a spec a generated client, a Swagger
UI, or a contract test can build against.

The package ships the route-shape **skeleton** only. Request and response body
*schemas* (the ones a [validation](/guides/validation) layer would describe) are a
deliberate post-1.0 follow-on, so every operation here carries a bare `200 OK` and
no body schema. That gap is documented, not accidental — see the notes below.

## Generate a document

`toOpenApi(routes, info, options?)` takes the route list, an `info` block, and an
optional filter. It returns a plain object — the OpenAPI document — which you hand
to `toJson` to serialize:

```ts
import { toJson, toOpenApi } from "@lesto/openapi";
import { app } from "./lesto.app";

const spec = toOpenApi(app.routes(), { title: "Blog", version: "1.0.0" });
const json = toJson(spec);
// json is 2-space-indented OpenAPI 3.1 JSON, ready to write to disk.
```

`app.routes()` is the single source of truth: the same list the router matches
against is the list you document, so the spec cannot drift from the running app.
Because `toOpenApi` takes that plain array — typed as `readonly RouteEntry[]` —
rather than a router object, it is decoupled from any one router. You can feed it
a hand-built list just as easily.

The `info` argument is an `OpenApiInfo`: `title` and `version` are required, and
`description` is optional. A description is emitted only when you pass one — the
`info` block stays minimal otherwise:

```ts
const spec = toOpenApi(app.routes(), {
  title: "Blog",
  version: "1.0.0",
  description: "The blog's public API.", // surfaced only when provided
});
```

## Paths, parameters, and operationIds

Each `RouteEntry` is a `{ method, pattern }` pair. The transform does three things
to it. The method is lowercased and becomes an operation key. The pattern's
`:param` segments become OpenAPI `{param}` placeholders in the path. And each
`:param` is declared as a required string path parameter, so a generated client
knows it must be filled in:

```ts
// Input route:  { method: "GET", pattern: "/posts/:id" }
// Becomes, under paths["/posts/{id}"]:
{
  get: {
    operationId: "getPostsId",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    responses: { "200": { description: "OK" } },
  },
}
```

The `operationId` is derived deterministically from the verb plus each path
segment capitalized — `GET /posts/:id` becomes `getPostsId`, unique per
method+pattern. Several verbs on the same path collect under one path key:
`GET`, `PATCH`, `PUT`, and `DELETE` on `/posts/:id` all live under
`paths["/posts/{id}"]`.

## Hiding internal routes

Not every route belongs in a public API surface — a health probe, an admin zone,
an internal RPC. There are two ways to drop a route, and either one is enough.

A route can declare its own visibility by carrying `internal: true` on its entry,
so the decision lives at the source:

```ts
const routes = [
  { method: "GET", pattern: "/posts" },
  { method: "GET", pattern: "/healthz", internal: true }, // dropped from the export
];
```

Or the caller can pass an `isInternal` predicate in `OpenApiOptions` to drop a
whole prefix without touching each route:

```ts
const spec = toOpenApi(app.routes(), { title: "Blog", version: "1.0.0" }, {
  isInternal: (route) => route.pattern.startsWith("/admin"),
});
```

The two combine: a route is excluded if its `internal` flag is set **or** the
predicate matches it. Filtering happens before the document is built, so a path
whose every route is internal leaves no empty bucket behind.

## The `lesto openapi` command

The CLI wraps the same generator. `lesto openapi` loads your app, builds the spec
with internal routes filtered out, and writes it to disk:

```bash
lesto openapi                                  # writes openapi.json
lesto openapi --out public/api.json            # choose the output path
lesto openapi --exclude /healthz --exclude /admin   # drop prefixes (repeatable)
```

`--exclude <prefix>` is repeatable and builds the `isInternal` predicate for you:
any route whose pattern starts with a given prefix is dropped, layered on top of
each route's own `internal` flag. The command prints the output path and the
number of exported paths, then a standing note that body schemas are not yet
emitted — so the gap is never mistaken for a bug. The CLI writes a fixed `info`
block (`title: "Lesto API"`, `version: "0.0.0"`); to set your own title and
version, call `toOpenApi` directly with an `info` argument as shown above.

## Notes and gotchas

- **Skeleton, not schemas.** Every operation carries a bare `200 OK` and no
  request or response body schema. Extracting those from the boundary validators
  is the explicit post-1.0 follow-on. If you need full request/response shapes
  today, layer them onto the emitted document yourself.
- **Path params only, always strings.** A `:param` becomes a `required` path
  parameter with `schema: { type: "string" }`. Query parameters, headers, and
  non-string param types are not inferred — the pattern is the only input.
- **The route list is the source of truth.** The spec is generated from
  `app.routes()`, the same list the router matches. There is nothing to keep in
  sync by hand, and no separate annotation file to drift.
- **Either rule excludes.** A route is internal if its own `internal` flag is set
  *or* `isInternal` (or a `--exclude` prefix) matches it. There is no way to
  re-include a route the other rule dropped within one call.
- **`info` is explicit in the library.** `toOpenApi` never invents a title or
  version — you pass them. The `lesto openapi` CLI uses fixed defaults; reach for
  the function directly when you want your own.

For how routes and the request `Context` are defined, see
[Routing & pages](/guides/routing). The companion agent-facing surface — the same
routes exposed over the Model Context Protocol — is described under
[Observability](/batteries/observability) and the broader [concepts](/concepts).
