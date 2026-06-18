# Deploying to Cloudflare

Lesto's flagship edge target is Cloudflare Workers. This is the framework-level
runbook; the worked reference is [`examples/estate`](../../examples/estate) — a real
deployed app whose [`README.md`](../../examples/estate/README.md) and
[`wrangler.jsonc`](../../examples/estate/wrangler.jsonc) you can copy.

## Model

The web tier is stateless — state lives in the one database — so a Worker is a pure
request handler. You ship two things: the Worker (your app behind the
`@lesto/cloudflare` fetch handler) and the island client assets. The **background
tier** (queue workers, the cron scheduler) can't live in a Worker — it runs as a
separate long-running Node process; see [deployment-topology.md](./deployment-topology.md).

## 1. A `wrangler.jsonc`

Start from estate's. The load-bearing parts are `nodejs_compat`, the assets binding,
and any data bindings (e.g. a `d1_databases` entry for the edge store). `@lesto/cloudflare`
can emit a config — see `wranglerConfig` — and estate's file is the reference.

## 2. The signing secret (fail-closed)

A deployed Lesto edge app **refuses to boot without `SESSION_SECRET`** — there is no
committed fallback. Set it as a wrangler secret (never commit it):

```sh
wrangler secret put SESSION_SECRET
```

## 3. Deploy

```sh
lesto deploy --cloudflare --health-url https://<your-worker-url>/readyz
```

`lesto deploy --cloudflare` builds the Worker + assets and pushes them via `wrangler`,
then runs the health check at `--health-url`. The result is **health-gated**: a failing
probe triggers a `wrangler rollback` so a broken deploy doesn't stay live.

## Versioned releases (self-hosted / S3 · R2)

For the self-hosted Node path, `lesto deploy` can publish an immutable, atomically-flipped
release instead of an in-place copy:

```sh
# local release store:
lesto deploy --release --version v3 --dist ./releases

# remote S3/R2 release store (credentials from the environment):
lesto deploy --release --bucket my-bucket --endpoint https://<account>.r2.cloudflarestorage.com --region auto

# roll the live pointer back to a prior version:
lesto rollback --to v2 --bucket my-bucket --endpoint https://<account>.r2.cloudflarestorage.com
```

A plain `lesto deploy` (no `--release`, no `--cloudflare`) prerenders static sites and
writes them to `--out`/`--dist` and prints the routing plan — the local-only path.

## Tracing (optional)

Set `LESTO_OTLP_URL` (plus `LESTO_OTLP_SERVICE` / `LESTO_OTLP_HEADERS`) to emit OTLP spans;
unset means tracing is off with zero overhead. On Workers the tracer flushes via
`waitUntil`. estate is the OTLP-on-Workers reference.

## Checklist

- [ ] `wrangler.jsonc` with `nodejs_compat` + assets (+ data bindings).
- [ ] `wrangler secret put SESSION_SECRET` (deploy fails closed without it).
- [ ] `lesto deploy --cloudflare --health-url …` is green.
- [ ] A cross-origin `POST` is refused at the edge (the secure stack is mounted).
