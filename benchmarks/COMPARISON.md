# Lesto cross-framework comparison (in-process)

Each contender runs the SAME workload through the SAME `@lesto/bench` runner,
back-to-back on this one machine. These are **in-process micro-benchmarks**:
they isolate a single code path (render, route-match) with no socket and no
server, so self-vs-self noise runs tens of percent run to run. Read the
_ranking_ and the _gap_, never the absolute ops/sec, and never compare across
machines. For the headline request-throughput numbers, see the real-server
load harness in `../driver` (run in CI / locally).

_recorded: 2026-06-24T01:04:05.551Z_

### SSR render (50-row list → HTML)

> All paths emit byte-identical markup. `react`/`preact` are the raw renderers; `lesto-registry` is Lesto's `renderPage`→`renderPageMarkup` JSON-UI path (it validates every node's props per render), so its number shows that path's overhead over the raw renderer. There is no bare `lesto` row: Lesto's plain-component renderer IS `react-dom/server`, so it renders at `react`'s speed by construction — timing it would just re-time the `react` row.

| Rank | Contender | ops/sec | % of fastest | p50 (ms) | p99 (ms) |
| ---: | --- | ---: | ---: | ---: | ---: |
| 🏆 1 | preact | 112312.49 | 100% | 0.008 | 0.0138 |
| 2 | react | 11185.58 | 9.96% | 0.0804 | 0.1076 |
| 3 | lesto-registry | 8353.89 | 7.44% | 0.0982 | 0.164 |

### Route match (mixed request stream)

> Lesto's compiled-RegExp `RouteTable` vs `find-my-way`'s radix tree on the same 12-request stream. NOT strictly equal work: Lesto URL-decodes every captured param at match time; find-my-way decodes lazily (only when the path contains `%`), so on these un-encoded paths it does less.

| Rank | Contender | ops/sec | % of fastest | p50 (ms) | p99 (ms) |
| ---: | --- | ---: | ---: | ---: | ---: |
| 🏆 1 | find-my-way | 614939.12 | 100% | 0.0014 | 0.0028 |
| 2 | lesto | 392975.56 | 63.9% | 0.0022 | 0.007 |

### Request dispatch — JSON (in-process, NOT apples-to-apples)

> ⚠️ Not identical work: `lesto-bare` returns a plain object; Hono/Elysia build + drain a web `Response`; Fastify uses light-my-request. A faster number can mean *did less*. `lesto-bare` is Lesto with the secure stack OFF (a secure-on in-process row would just measure rate-limit 429s on a shared bucket). The apples-to-apples comparison — real socket, success-rate, tail latency, and the secure stack's real cost — is the real-server suite in `../driver`.

| Rank | Contender | ops/sec | % of fastest | p50 (ms) | p99 (ms) |
| ---: | --- | ---: | ---: | ---: | ---: |
| 🏆 1 | lesto-bare | 1411412.18 | 100% | 0.0005 | 0.0024 |
| 2 | elysia | 1247774.28 | 88.41% | 0.0007 | 0.0026 |
| 3 | hono | 540504.02 | 38.3% | 0.0013 | 0.0062 |
| 4 | fastify | 130869.53 | 9.27% | 0.0063 | 0.0179 |

### Request dispatch — plaintext (in-process, NOT apples-to-apples)

> ⚠️ Not identical work: `lesto-bare` returns a plain object; Hono/Elysia build + drain a web `Response`; Fastify uses light-my-request. A faster number can mean *did less*. `lesto-bare` is Lesto with the secure stack OFF (a secure-on in-process row would just measure rate-limit 429s on a shared bucket). The apples-to-apples comparison — real socket, success-rate, tail latency, and the secure stack's real cost — is the real-server suite in `../driver`.

| Rank | Contender | ops/sec | % of fastest | p50 (ms) | p99 (ms) |
| ---: | --- | ---: | ---: | ---: | ---: |
| 🏆 1 | elysia | 1760983.47 | 100% | 0.0005 | 0.0017 |
| 2 | lesto-bare | 1633903.5 | 92.78% | 0.0004 | 0.0035 |
| 3 | hono | 919663.49 | 52.22% | 0.0008 | 0.0032 |
| 4 | fastify | 147119.45 | 8.35% | 0.0061 | 0.0168 |
