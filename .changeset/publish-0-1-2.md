---
"@lesto/assets": patch
"@lesto/auth": patch
"@lesto/authz": patch
"@lesto/cli": patch
"@lesto/cloudflare": patch
"@lesto/content-core": patch
"@lesto/content-embeddings": patch
"@lesto/content-markdown": patch
"@lesto/content-search": patch
"@lesto/content-shared": patch
"@lesto/content-store": patch
"@lesto/content-umbra": patch
"@lesto/cors": patch
"@lesto/csrf": patch
"@lesto/db": patch
"@lesto/deploy": patch
"@lesto/env": patch
"@lesto/errors": patch
"@lesto/island-dev": patch
"@lesto/kernel": patch
"@lesto/mcp": patch
"@lesto/migrate": patch
"@lesto/observability": patch
"@lesto/openapi": patch
"@lesto/pg": patch
"@lesto/queue": patch
"@lesto/ratelimit": patch
"@lesto/router": patch
"@lesto/runtime": patch
"@lesto/seo": patch
"@lesto/sites": patch
"@lesto/storage": patch
"@lesto/styles": patch
"@lesto/ui": patch
"@lesto/web": patch
"create-lesto": patch
---

Publish 0.1.2 — republish the full public surface carrying the fixed `create-lesto` scaffold closure.

Published `create-lesto@0.1.1` scaffolded a closure that did not declare `@lesto/observability`, so a real `npm create lesto` app built fine under a hoisting install but hard-failed under bun `--linker=isolated` / pnpm-strict / Yarn PnP with `Cannot find module @lesto/observability/rum`. The scaffold now declares `@lesto/observability` (runtime), `@lesto/styles`, `@lesto/island-dev` + the `@prefresh/*` Fast-Refresh runtime. This release also carries the FIRST publish of `@lesto/styles` and `@lesto/island-dev` (both 404 on the registry before 0.1.2).
