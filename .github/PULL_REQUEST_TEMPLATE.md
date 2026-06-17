<!-- Small, focused PRs get reviewed fastest. See CONTRIBUTING.md. -->

## What this changes

A short description of the change and why.

## How I verified it

Which gate commands you ran (all four must be green):

- [ ] `bun run ws:typecheck`
- [ ] `bun run ws:lint`
- [ ] `bun run ws:format:check`
- [ ] `bun scripts/coverage-gate.ts` (100% coverage on touched non-preview packages)

## Checklist

- [ ] Conventional, one-line commit subject(s); one focused change per commit.
- [ ] Errors carry stable `code`s; callers can branch on `code`, not message.
- [ ] Wired into `examples/estate` if this changes runtime behavior or public surface.
- [ ] Docs/comments updated where the change makes an existing claim untrue.
