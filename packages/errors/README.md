# @lesto/errors

> Lesto's shared error foundation — the LestoError base every package error extends, plus a Result type.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/errors
```

```ts
import { LestoError, isErr, ok, err, unwrap } from "@lesto/errors";

// Every failure is a LestoError subclass with a stable, machine-readable code.
class WidgetError extends LestoError<"WIDGET_NOT_FOUND"> {}

function find(id: string) {
  return id ? ok({ id }) : err(new WidgetError("WIDGET_NOT_FOUND", `no widget ${id}`));
}

const result = find("42");
if (isErr(result)) throw result.error; // branch on result.error.code — never a message
use(unwrap(result));
```

Recognize the base `LestoError` via `isLestoError` / `hasCode` (a cross-copy brand
check), never `instanceof` — a duplicate install breaks class identity.

[Docs](https://docs.lesto.run) · [Agent-readable docs](https://docs.lesto.run/llms.txt)
