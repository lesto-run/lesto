# @lesto/island-dev

> Lesto's dev-only island bundler (DX-parity R2, ADR 0011) — a loopback Vite dev server (CLI-proxied) with React/Preact Fast Refresh, wrapped behind a pure seam so `lesto dev` preserves island state on edit. The real Vite + plugin wiring lives in a separate coverage-excluded edge; the orchestration is covered with fakes.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/island-dev
```

[Docs](https://docs.lesto.run) · [Agent-readable docs](https://docs.lesto.run/llms.txt)
