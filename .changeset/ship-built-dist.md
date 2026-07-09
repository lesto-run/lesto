---
"@lesto/errors": patch
---

Publish compiled `dist/*.js` + `.d.ts` instead of raw TypeScript source.

Every `@lesto/*` package (and `create-lesto`) previously shipped `exports → ./src/*.ts` with no build step, so a standard consumer could not use them: `npm i @lesto/<pkg>` + `import` under plain Node threw `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` (Node refuses to strip types under `node_modules`), and the same raw `.ts`/`.tsx` broke webpack (which excludes `node_modules` from transpile) and forced a `wrangler deploy` to inherit the framework's JSX/preact-alias/`@types/node` transform burden. It only worked under Bun or the `lesto` CLI (which runs source through jiti).

Packages are now built with tsup and publish `dist` artifacts, with `exports`/`main`/`types` pointing at the built files (source is not shipped). In-repo development is unchanged — it still runs TypeScript from `src`; the `src → dist` swap happens only at pack time. A new `import-proof` CI job (`test:pack-import`) installs the packed tarballs and `import`s them under plain Node so this can't regress.
