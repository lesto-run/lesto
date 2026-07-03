# Runbook: rotate `ALCHEMY_STATE_TOKEN`

`ALCHEMY_STATE_TOKEN` is the one shared secret behind the account-wide Alchemy state worker
(`alchemy-state-service`, [ADR 0044](../adr/0044-deploy-iac-convention-alchemy.md) D4/D5). It is both
the **bearer token** used to reach that worker and the **passphrase** its state secrets are encrypted
under, so it must be **byte-for-byte identical** in three places:

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

1. **Re-key the worker first** — deploys `examples/mcp-auth-openauth` with `ALCHEMY_STATE_FORCE_UPDATE=1`
   under `ALCHEMY_STAGE=prod`. A successful deploy *is* the proof the worker now accepts the new token
   (Alchemy polls the worker with it). If this step fails, nothing else is touched — the old token
   stays authoritative everywhere.
2. **Write** `~/.alchemy/lesto-alchemy-state-token.txt` (mode 600, no trailing newline).
3. **Set** the `ALCHEMY_STATE_TOKEN` GitHub secret (value piped via stdin, never an arg).
4. **Dispatch** the `deploy-examples` workflow so CI redeploys **every** sharing app under the new
   token — necessary because the token also encrypts state secrets, so each app must re-encrypt.

Prereqs: an `alchemy login` profile (`~/.alchemy/credentials`) for the CF account, and an
authenticated `gh` for the repo.

Confirm green:

```bash
gh run watch --workflow=deploy-examples.yml
```

## Re-key without rotating (fix drift)

If the three copies have drifted but you know the intended value (e.g. it's already in
`~/.alchemy/lesto-alchemy-state-token.txt` and the GitHub secret, and only the worker is stale), just
re-key the worker to that value — no new token, no re-encryption concern:

```bash
export ALCHEMY_STATE_TOKEN="$(cat ~/.alchemy/lesto-alchemy-state-token.txt)"
ALCHEMY_STATE_FORCE_UPDATE=1 ALCHEMY_STAGE=prod bun examples/mcp-auth-openauth/alchemy.run.ts
```

Then make sure the GitHub secret matches:

```bash
gh secret set ALCHEMY_STATE_TOKEN < ~/.alchemy/lesto-alchemy-state-token.txt
```

## Notes

- **Re-encryption:** rotating changes the passphrase that encrypts secrets in shared state, so any app
  with secrets in state must be redeployed under the new token or those secrets orphan. Step 4 does
  this for the repo's Alchemy apps by redeploying all of them via CI. If you add a new Alchemy app,
  it's covered automatically as long as `deploy-examples.yml` deploys it.
- **Blast-radius during a rotation:** between step 1 (worker re-keyed) and step 3 (secret set) there's
  a brief window where CI would 401. Rotations are deliberate and quiet, so this is fine — just don't
  push to `main` mid-rotation.
- The value is never printed by the script or this runbook; compare copies with `shasum -a 256` if you
  need to check them without revealing the token.
