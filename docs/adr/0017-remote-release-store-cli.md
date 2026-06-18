# ADR 0017 — `lesto deploy --release` reaches a generic S3/R2 static target

- **Status:** Accepted
- **Date:** 2026-06-17

## Context

`@lesto/deploy` shipped a complete, fully-tested `remoteReleaseStore` — the same
versioned-release machinery (`shipRelease`/`rollback`: stage every file under an
immutable `releases/<version>/` prefix, then flip a `current` pointer atomically)
over a generic S3-compatible object store, speaking the S3 REST API over `fetch`
with in-house SigV4 (`@lesto/storage`), Workers-clean. But **nothing wired it into
the CLI**: `lesto deploy --release` and `lesto rollback` could only ever reach the
local on-disk `nodeReleaseStore`, because the `releaseStore` seam was
`(distDir: string) => ReleaseStore` — disk-shaped by construction. The headline
remote target was reachable from a library call and a test, never from the tool.
ADR 0015 named this exact gap as a deferred follow-up.

The wiring has one real hazard: **credentials**. A deploy needs SigV4 access keys,
and the cardinal rule is that a secret must never ride a CLI flag (shell history),
a log line, or — Lesto's stable-error-code contract — an error's `details`.

## Decision

Generalize the seam to a discriminated **release target** the core resolves from
flags, and read credentials from the environment in the wiring:

- **`CliDeps.releaseStore` becomes `(target: ReleaseTarget) => ReleaseStore`**,
  where `ReleaseTarget` is `{ kind: "local"; distDir }` or
  `{ kind: "remote"; endpoint; bucket; region; pointerKey? }`. `runDeploy`'s
  release branch and `runRollback` share one `releaseTargetFromArgs(args)` resolver,
  so deploy and rollback always agree on where a release lives.
- **Flags select the store.** Naming a `--bucket` (or `--endpoint`) selects the
  remote S3/R2 store; the two are required *together*, so a typo in either surfaces
  as `CLI_DEPLOY_INCOMPLETE_REMOTE` rather than silently shipping to local disk.
  `--region` defaults to `auto` (R2; S3 passes its own), and `--pointer` overrides
  the live-pointer key (one bucket, many sites). With neither flag, the target is
  the local `--dist` store — the prior behaviour, unchanged.
- **Remote flags imply `--release`.** The remote store is *only* ever a release
  store (immutable trees + an atomic pointer — there is no in-place remote copy),
  so `--bucket`/`--endpoint` opt into the release path on their own; a remote deploy
  never needs to also pass `--release`. This is also what closes the footgun: remote
  flags can never fall through to the legacy local copy when `--release` is omitted.
- **Credentials live in the environment, read only in the coverage-excluded bin.**
  `releaseStore` maps a `local` target to `nodeReleaseStore` and a `remote` one to
  `remoteReleaseStore`, sourcing `accessKeyId`/`secretAccessKey`/`sessionToken`
  from the environment as a **family** — the `LESTO_DEPLOY_*` set when its access key
  is present, else the conventional `AWS_*` names CI already injects. Picking the
  prefix once (not per field) means a `LESTO_DEPLOY_` key can never be paired with an
  `AWS_` secret into a mismatched keypair. A missing key fails with a clear,
  secret-free message. The CLI core never handles a secret — it only ever builds the
  addressing-only `ReleaseTarget`, which is exactly what the tests assert on.

```
# Publish the prerendered static zone to Cloudflare R2, versioned + atomic:
export LESTO_DEPLOY_ACCESS_KEY_ID=…  LESTO_DEPLOY_SECRET_ACCESS_KEY=…
lesto deploy --release --target marketing \
  --bucket my-site --endpoint https://<account>.r2.cloudflarestorage.com
# Roll the live pointer back in one step (same bucket addressing):
lesto rollback --to <version> --bucket my-site --endpoint https://<account>.r2.cloudflarestorage.com
```

## Consequences

- `lesto deploy --release` / `lesto rollback` now target a generic S3/R2 bucket, so
  the framework's versioned-release machinery is load-bearing on a real CDN, not
  only local disk — finishing the static half of ADR 0015's deploy blocker.
- The credential edge (env read + real `remoteReleaseStore` construction) lives in
  the coverage-excluded wiring, exactly like the `wrangler` driver; the CLI core's
  orchestration (resolve target → ship/flip) stays at 100% coverage with the seam
  faked. The `remoteReleaseStore` end-to-end behaviour is already proven in
  `@lesto/deploy`'s `remote.test.ts` against an R2-shaped `fetch` fake.
- Like the `--cloudflare` Worker path (ADR 0015), a **live** remote deploy is not
  exercised in CI — it needs a real bucket and credentials this repo's CI lacks.
  The tested contract is the flag→target resolution and the unchanged release/flip
  order; the wire protocol is the already-tested store.
- **Not changed here:** a pre-flip health gate over the *staged* remote release
  (meaningless without a staged-release-preview convention — the staged files are
  not behind the pointer yet); and a deploy-config surface so `--bucket`/`--endpoint`
  could be read from project config instead of flags.
