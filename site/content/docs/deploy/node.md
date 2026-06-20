---
title: Node
description: Run a Lesto app as a long-lived Node server — the same app you deploy to the edge, with a process for background work.
section: Deploy
order: 1
---

# Deploy to Node

The same app that runs on Cloudflare runs as a long-lived Node process. The Node
tier is the right home for anything that wants a steady process: a background
**[queue](/batteries/queue)** worker, a cron scheduler, an OTLP flush on an
interval.

## Serve

`lesto serve` boots the app over `node:http` with the full front door — per-request
context, body cap, handler-timeout abort, slow-loris socket limits, and a SIGTERM
drain:

```bash
lesto build      # apply migrations, prepare assets
lesto serve --port 3000
```

The front door applies the same hardening the edge Worker does; only the
transport differs.

## A worker process

Background work runs in the same process (or a second one pointed at the same
database). A queue worker is a loop you start after boot:

```ts
const queue = new Queue(db);
const worker = queue.work({ onJob: async (job) => handle(job) });
```

## Topology

A typical production shape is a **Workers** web tier at the edge plus a
long-running **Node** worker process, both over one **Postgres**. The web tier
serves requests with low latency; the Node process owns the queue and schedules.
Develop against local SQLite, then point the same app at Postgres — the
**[data layer](/batteries/data)** runs unchanged on either.

For the edge half, see **[Deploy to Cloudflare](/deploy/cloudflare)**.
