/**
 * Per-worker test warm-up: pay the sanitizer's one-time cold-init cost HERE, once,
 * so no individual test absorbs it.
 *
 * The first `sanitizeHtml` call cold-inits the Node sanitizer — `require("jsdom")`
 * (loading jsdom's large module graph) plus a `new JSDOM("")` to give DOMPurify a DOM
 * (see `src/sanitize.ts`). On a contended CI runner that one load can exceed vitest's
 * 5s default `testTimeout`, so whichever test happened to sanitize first flaked. The
 * old fix bumped `testTimeout` to 30s, which HID the cost — but loosened hang detection
 * for the other ~390 tests along with it.
 *
 * `setupFiles` run IN the test worker process (unlike `globalSetup`), so warming the
 * sanitizer here primes Node's `require` cache for jsdom for every test that worker then
 * runs — the expensive module load is cached for the worker's lifetime (a later
 * `resetPurifyInstanceForTest()` only clears the memoized instance, not the require
 * cache). Each subsequent `sanitizeHtml` runs in <50ms, so the tight 5s default returns.
 *
 * The empty-string input exercises the full init path (require + `new JSDOM`) while
 * sanitizing nothing. Under Node (this suite's default environment) the sanitizer is
 * supported, so this returns `""`; if it ever threw (a DOM-less runtime), the warm-up
 * failing loud is the correct signal — the suite could not sanitize anyway.
 *
 * `markdown.ts` has the SAME shape of cost the old 30s timeout was also hiding: its first
 * call lazy-`import`s a second heavy graph (unified/remark-parse/unist-util-visit/
 * mdast-util-to-string/github-slugger). `extractHeadings("")` pulls that whole set (the
 * superset of `extractPlainText`'s) once per worker, so dropping the timeout doesn't just
 * shift the flake window from the sanitizer to the first markdown test.
 */
import { extractHeadings } from "../src/markdown.js";
import { sanitizeHtml } from "../src/sanitize.js";

sanitizeHtml("");
await extractHeadings("");
