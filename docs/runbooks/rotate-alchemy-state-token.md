# Runbook: rotate `ALCHEMY_STATE_TOKEN`

`ALCHEMY_STATE_TOKEN` is the one shared **bearer credential** for the account-wide Alchemy state worker
(`alchemy-state-service`, [ADR 0044](../adr/0044-deploy-iac-convention-alchemy.md) D4/D5) — the worker
checks it on every request (it is the worker's `STATE_TOKEN` binding). It is **not** an at-rest
encryption key: Alchemy stores state verbatim and encrypts any secret *values* under a separate
`ALCHEMY_PASSWORD` this repo does not set. The token must be **byte-for-byte identical** in three
places:

| # | Copy | How it changes |
|---|------|----------------|
| 1 | The live `alchemy-state-service` worker's `STATE_TOKEN` binding | **Only** on a `forceUpdate` deploy |
| 2 | `~/.alchemy/lesto-alchemy-state-token.txt` (durable local copy) | You write the file |
| 3 | The `ALCHEMY_STATE_TOKEN` GitHub Actions secret | `gh secret set` |

If they drift, every `bun alchemy.run.ts` fails with:

```
error: [CloudflareStateStore] The token is invalid. Please check your ALCHEMY_STATE_TOKEN …
```

**The load-bearing gotcha:** copy #1 does not follow #2/#3. Changing the secret or the file alone
leaves the worker on the old value → 401. The worker is re-keyed *only* by deploying with
`ALCHEMY_STATE_FORCE_UPDATE=1`, which every `alchemy.run.ts` reads:

```ts
stateStore: (scope) =>
  new CloudflareStateStore(scope, {
    forceUpdate: process.env.ALCHEMY_STATE_FORCE_UPDATE === "1",
  }),
```

## Rotate (the happy path)

```bash
bun scripts/rotate-alchemy-state-token.ts            # dry-run: prints the plan, changes nothing
bun scripts/rotate-alchemy-state-token.ts --confirm  # rotate for real
```

The script derives all three copies from **one** freshly generated value, in an order that can't half-
apply:

A pre-flight refuses to run unless `gh` is authenticated and the working tree is clean (the re-key
deploys from local code to prod), so the usual slips fail before anything changes. Then:

1. **Re-key the worker first** — deploys `examples/mcp-auth-openauth` with `ALCHEMY_STATE_FORCE_UPDATE=1`
   under `ALCHEMY_STAGE=prod`. A successful deploy *is* the proof the worker now accepts the new token
   (Alchemy polls the worker with it). The local file and CI secret are only touched *after* this
   succeeds. If the deploy fails *after* the re-key (it happens early in the deploy), the worker may
   already hold the new token this run didn't save — harmless, because re-running force-overwrites the
   worker to a fresh, saved token.
2. **Write** `~/.alchemy/lesto-alchemy-state-token.txt` (mode 600, no trailing newline) and **set** the
   `ALCHEMY_STATE_TOKEN` GitHub secret (value piped via stdin, never an arg).
3. **Dispatch** the `deploy-examples` workflow as a **smoke test** — confirms every app deploys green
   now that CI's secret matches the re-keyed worker. This is *not* a re-encryption (the token is a
   bearer credential, so re-keying changes nothing in stored state); it just verifies the rotation
   end-to-end.

Prereqs: an `alchemy login` profile (`~/.alchemy/credentials`) for the CF account, and an
authenticated `gh` for the repo.

Confirm green:

```bash
gh run list --workflow=deploy-examples.yml --limit 1   # grab the run id
gh run watch <run-id>
```

## Re-key without rotating (fix drift)

If the three copies have drifted but you know the intended value (e.g. it's already in
`~/.alchemy/lesto-alchemy-state-token.txt` and the GitHub secret, and only the worker is stale), just
re-key the worker to that value — no new token. Run it **from inside the example dir** (the
`alchemy.run.ts` resolves its Worker entrypoint relative to the cwd):

```bash
cd examples/mcp-auth-openauth
export ALCHEMY_STATE_TOKEN="$(cat ~/.alchemy/lesto-alchemy-state-token.txt)"
ALCHEMY_STATE_FORCE_UPDATE=1 ALCHEMY_STAGE=prod bun alchemy.run.ts
```

Then make sure the GitHub secret matches — write the file **without** a trailing newline (an `echo >`
adds one; `printf %s` does not), or the secret ends up one byte longer than the worker binding and 401s:

```bash
gh secret set ALCHEMY_STATE_TOKEN < ~/.alchemy/lesto-alchemy-state-token.txt
```

## Notes

- **Bearer, not encryption key:** rotating the token does **not** re-encrypt or orphan anything —
  Alchemy stores state verbatim and this repo sets no `ALCHEMY_PASSWORD`, so nothing in state depends
  on the token's value. Every app simply needs its CI secret updated (done here) and picks up the new
  token on its next deploy; the step-3 dispatch just confirms that end-to-end.
- **Blast-radius during a rotation:** between the re-key (step 1) and the secret set (step 2) there's a
  brief window where CI would 401. Rotations are deliberate and quiet, so this is fine — just don't
  push to `main` mid-rotation.
- The value is never printed by the script or this runbook; compare copies with `shasum -a 256` if you
  need to check them without revealing the token.
