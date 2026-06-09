# Code Patterns

## Avoid

- Extra comments that a human wouldn't add or are inconsistent with the rest of the file
- Defensive checks or try/catch blocks that are abnormal for that area of the codebase (especially if called by trusted/validated codepaths)
- Casts to `any` to get around type issues
- Any style inconsistent with the surrounding code

## Optional Properties

With `exactOptionalPropertyTypes` enabled, use clean optional types without `| undefined`:

```ts
// Good
interface Options {
  foo?: string;
  bar?: (x: number) => void;
}

// Bad
interface Options {
  foo?: string | undefined;
  bar?: ((x: number) => void) | undefined;
}
```

When calling functions with optional properties, omit undefined values rather than passing them:

```ts
// Good
doSomething({
  ...(foo && { foo }),
  bar,
})

// Bad
doSomething({
  foo,  // passes undefined explicitly
  bar,
})
```
