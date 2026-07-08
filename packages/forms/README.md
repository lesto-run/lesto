# @lesto/forms

> Schema-driven forms on @lesto/ui — one spec renders the form and validates the submission.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/forms
```

```ts
import { createFormRegistry, renderForm, validateSubmission, type FormSpec } from "@lesto/forms";

const spec: FormSpec = {
  action: "/signup",
  fields: [
    { name: "email", type: "email", required: true },
    { name: "age", type: "number" },
  ],
};

const tree = renderForm(spec);                              // a @lesto/ui node tree
const { valid, errors } = validateSubmission(spec, body);  // built-in validator → per-field errors
```

Ships its own form components — it uses `@lesto/ui`'s engine and types (not
shadcn/zod), and the built-in validator returns per-field errors you render
inline on a 422.

[Docs](https://docs.lesto.run) · [Example](../../examples/forms)
