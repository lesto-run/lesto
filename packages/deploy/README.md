# @lesto/deploy

> Lesto deploy adapters — turn a built site set into a concrete deploy plan and ship its static targets through an injected uploader.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/deploy
```

```ts
import { planDeploy, shipStatic, nodeUploader } from "@lesto/deploy";

// Read the site set + build manifest into per-site deploy targets.
const plan = planDeploy(sites, manifest);

for (const target of plan.targets) {
  if (target.kind === "static") {
    await shipStatic(target, "out", nodeUploader("dist"));
  }
}

// plan.routing — the edge router's rules, most-specific prefix first.
```

[Docs](https://docs.lesto.run) · [Agent-readable docs](https://docs.lesto.run/llms.txt)
