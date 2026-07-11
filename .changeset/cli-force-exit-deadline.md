---
"@lesto/runtime": minor
"@lesto/cli": patch
---

The CLI now force-exits a wedged shutdown instead of hanging until `SIGKILL`.

`lesto`'s signal handler delegates to `onShutdownSignals(drain)`, which added a double-signal guard but passed no force-exit deadline — so a genuinely wedged teardown (a `dev` drain closing watchers/WS/db that never settles) left the user with only a second, now-no-op Ctrl-C. `@lesto/runtime` exports `DEFAULT_FORCE_EXIT_TIMEOUT_MS` (15s = the 10s drain window + 5s grace, the same arithmetic `serveWithGracefulShutdown` already uses), and the CLI wires it into `installShutdown`. The timer is armed once on the first signal, `unref`'d, and cleared on a clean settle; the double-signal remains a strict no-op.
