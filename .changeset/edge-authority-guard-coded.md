---
"@lesto/cloudflare": patch
---

Edge authority-confusion guard: emit a CODED 400 and cover the static-asset front door.

The edge guard that refuses an authority-confusion request target (a path
beginning `//`, e.g. `//evil/admin` — the proxy-ACL-bypass shape the node tier's
`parseRequestTarget` rejects) now behaves consistently with the node front door
and no longer leaves a gap in the canonical `withAssets(env.ASSETS, ...)` deploy:

- **Coded, not bare.** The guard in `dispatchHardened` now THROWS a
  `RUNTIME_INVALID_REQUEST_TARGET` `LestoError` (the same code the node runtime
  raises), which the existing `catch → statusForError` maps to a 400 — instead of
  returning a bare, uncoded 400 inline. So the two runtimes' guards can no longer
  silently diverge (one coded, one bare), and one telemetry pipeline reads the same
  error identity on either tier. The wire response is unchanged (400 "Bad Request").
- **The asset front door is guarded too.** `withAssets` hands every `GET`/`HEAD`
  to the assets fetcher with the raw url FIRST; a `//`-prefixed path is never a
  legitimate static file, so it is now diverted straight to the app handler (which
  owns the coded guard) BEFORE `assets.fetch` — closing the defense-in-depth gap
  where an asset fetcher that normalized or served such a path (rather than 404ing
  and falling through) could have shadowed the guard.

The node tier keeps its early parse-time `parseRequestTarget` guard as
belt-and-braces; a legitimate single-slash origin-form path routes exactly as
before.
