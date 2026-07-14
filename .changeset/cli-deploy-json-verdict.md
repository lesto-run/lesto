---
"@lesto/cli": minor
---

`lesto deploy --cloudflare --json` appends a versioned machine-readable verdict as the final line of stdout, so orchestrators read the health-gate outcome instead of scraping the CLI's human prose.

The verdict is `{ schemaVersion: 1, status: "retained" | "rolled-back" | "failed", deployedUrl, healthUrl, errorCode, message }` (the `DeployJsonVerdict` type). Exactly one is emitted per `--json` run: `retained` when the deploy is live (gate passed, or skipped with `healthUrl: null` when there was no URL to probe), `rolled-back` when the gate failed and the previous deployment was restored, and `failed` for any coded refusal — including the gate-failed-AND-rollback-failed state, where the unhealthy Worker may still be serving. Wrangler's streamed transcript precedes the verdict, so consumers must take the last stdout line that parses and validates; a run that emits no verdict (a non-coded crash) is unknown, and nothing may be inferred from the absence. `--json` without `--cloudflare` is refused loud (`CLI_DEPLOY_JSON_UNSUPPORTED`) — the static-ship path has no single verdict to report.

Also: a post-deploy rollback that itself fails is now a coded `CLI_DEPLOY_ROLLBACK_FAILED` (in `--json` mode and out) instead of an uncoded rethrow — previously it surfaced as a bare stack whose text contains the word "rollback", which prose-scraping consumers read as a successful revert while the unhealthy Worker was still live.
