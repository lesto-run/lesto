# Plan 005: Give the CLI a central coded-error handler

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- packages/cli/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: correctness / DX
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters

The whole CLI is built on coded errors: `run()` throws `CliError`
(a `LestoError` subclass) for `CLI_UNKNOWN_COMMAND`, and every sub-command
(`content:new` with missing args, `CLI_ADD_UNKNOWN_INTEGRATION`,
`CLI_CLIENT_BUILD_FAILED`, `CLI_DEPLOY_UNHEALTHY`, …) throws a coded error too.
But the entrypoint calls `await run(argv, …)` with **no try/catch**, and the
`bin/lesto.mjs` wrapper adds none either. So a coded `CliError` propagates as a
top-level unhandled rejection: the user sees a full stack trace instead of the
one-line human message the error codes were designed to produce, and the exit
status relies on Node's unhandled-rejection default. The error-code convention
is defeated at the outermost boundary of the tool users touch most. The fix is a
small central catch at the entrypoint that prints the code + message and exits 1.

## Current state

- `packages/cli/src/bin.ts` — the Node entrypoint. `run()` is awaited with no
  guard, and only non-long-running commands call `process.exit`:
  ```ts
  // packages/cli/src/bin.ts:1415
  const code = await run(argv, {
    loadApp,
    serve,
    // ... many deps ...
    out: console.log,
  });

  // packages/cli/src/bin.ts:1464
  // Long-running commands keep the process alive on their own socket; everything
  // else has said all it has to say, so exit with the code the core returned.
  if (argv[0] !== "serve" && argv[0] !== "dev") process.exit(code);
  ```
- `packages/cli/src/run.ts` — the command core. It has NO top-level catch; it
  throws coded errors directly:
  ```ts
  // packages/cli/src/run.ts:2574
  export async function run(argv: readonly string[], deps: CliDeps): Promise<number> {
    const [command, ...args] = argv;
    // ... dispatch ...
    // packages/cli/src/run.ts:2614
    throw new CliError("CLI_UNKNOWN_COMMAND", `Unknown command: "${command}".`, { command });
  }
  ```
- `CliError extends LestoError` (`packages/cli/src/errors.ts:44`), and the base
  is recognized via the brand helper, not `instanceof`:
  ```ts
  // packages/cli/src/run.ts:18 (already imported in run.ts; import into bin.ts)
  import { hasCode, isLestoError } from "@lesto/errors";
  ```

### Conventions to follow

- **Recognize the base `LestoError` via `isLestoError`, never `instanceof`**
  (`CONVENTIONS.md` → "Errors carry codes"): a duplicate `@lesto/errors` install
  breaks class identity. `bin.ts` already imports several `@lesto/*` packages;
  add `import { isLestoError } from "@lesto/errors";`.
- A coded error prints its **message** (human-facing) to stderr and exits `1`.
  A non-coded (unexpected) error must **rethrow** — it is a real bug and should
  keep its stack; do not swallow it.
- Do not print the stack for coded errors; the code+message is the contract.

## Commands you will need

| Purpose   | Command                                   | Expected on success |
|-----------|-------------------------------------------|---------------------|
| Typecheck | `cd packages/cli && bun run typecheck`    | exit 0 |
| Test+cov  | `cd packages/cli && bun run test:cov`     | all pass, 100% cov |
| Lint      | `cd packages/cli && bun run lint`         | exit 0 |
| Format    | `cd packages/cli && bun run format:check` | exit 0 |
| Smoke     | `cd packages/cli && bun run src/bin.ts wat 2>&1 \| head` | one-line coded message, no stack |

## Scope

**In scope**:
- `packages/cli/src/bin.ts` (add the central catch)
- `packages/cli/test/*.ts` — if the entrypoint is covered by tests; see Test plan.

**Out of scope** (do NOT touch):
- `run()` and the sub-command functions in `run.ts` — they keep throwing coded
  errors; only the entrypoint gains the catch.
- The `serve`/`dev` keep-alive path's normal operation — the catch only fires on
  a rejected `run(...)` (a real startup error), never during healthy long-running
  operation, because `await run(...)` for those commands resolves/rejects only
  when the server stops.
- `bin/lesto.mjs` (the jiti wrapper) — the catch belongs in `bin.ts`.

## Git workflow

- Commit style: `fix(cli): surface coded CliErrors as one-line messages instead of raw stack traces`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add the central catch at the entrypoint

Wrap the `await run(...)` call at `bin.ts:1415`. On a coded error, print the
message to stderr and exit 1; otherwise rethrow. Preserve the existing
long-running-command exit logic for the success path:
```ts
import { isLestoError } from "@lesto/errors";
// ...
let code: number;
try {
  code = await run(argv, {
    loadApp,
    // ... unchanged deps ...
    out: console.log,
  });
} catch (error) {
  if (isLestoError(error)) {
    // Print the code too — CLI output is first-class (CONVENTIONS "Logs") and
    // agents consuming stderr branch on codes (ADR 0035).
    console.error(`${error.code}: ${error.message}`);
    process.exit(1);
  }
  throw error; // unexpected: keep the stack, let it surface as a real bug
}

if (argv[0] !== "serve" && argv[0] !== "dev") process.exit(code);
```

**Verify**: `cd packages/cli && bun run typecheck` → exit 0.

### Step 2: Smoke-check the behavior

**Verify**: `cd packages/cli && bun run src/bin.ts wat 2>&1 | head`
→ prints a single line like `Unknown command: "wat".` and **no** stack trace;
`echo $?` after it (without the pipe) is `1`.

### Step 3: Full local gate

**Verify**:
```
cd packages/cli && bun run typecheck && bun run lint && bun run format:check && bun run test:cov
```
→ all exit 0, 100% coverage.

## Test plan

- **`bin.ts` is coverage-excluded** (`packages/cli/vitest.config.ts:15`), so the
  inline catch needs **no new unit test** and the coverage gate stays green — do
  not invent a `handleCliError` seam just to test it. The oracle is the smoke in
  Step 2: `bun run src/bin.ts wat` prints a one-line `CLI_UNKNOWN_COMMAND: …`
  message with no stack and exits 1.
- If you want a regression guard anyway, add it at the `run()` level (which IS
  tested): assert `run(["wat"], deps)` rejects with a `CliError` whose `code` is
  `CLI_UNKNOWN_COMMAND` — that pins the coded-throw the catch depends on.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd packages/cli && bun run typecheck` exits 0
- [ ] `cd packages/cli && bun run test:cov` exits 0, 100% coverage
- [ ] `cd packages/cli && bun run lint && bun run format:check` exit 0
- [ ] `cd packages/cli && bun run src/bin.ts wat 2>&1 | head` prints a one-line coded message with no stack trace
- [ ] `grep -n "isLestoError" packages/cli/src/bin.ts` shows the central catch
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row for 005 updated

## STOP conditions

Stop and report back if:

- `bin.ts:1415` / `run.ts` do not match the "Current state" excerpts (drift).
- Adding the catch breaks the `serve`/`dev` keep-alive behavior in a test
  (it should not — those commands resolve only on shutdown).
- Reaching 100% coverage would force turning `bin.ts` into an awkward testable
  shape; use the small `handleCliError` helper seam described in the Test plan
  instead, and report that you did.

## Maintenance notes

- Any new long-running command (beyond `serve`/`dev`) must be added to the
  `argv[0] !== …` success-path exit guard AND is covered by the catch for
  startup failures automatically.
- Reviewer should confirm non-coded errors are rethrown (not swallowed) so real
  bugs still surface with a stack.
