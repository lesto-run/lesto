# @lesto/cli

> Lesto's `lesto` command-line tool — load a project's lesto.app.ts and run, serve, migrate, or inspect routes.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/cli
```

```bash
lesto dev        # boot the dev server + loopback MCP control plane
lesto serve      # run the production server
lesto migrate    # apply pending migrations
lesto routes     # print the route table
```

The command brain is a pure, fully-injectable `run` (exported from the package);
the `lesto` executable is the thin wiring that builds the real dependencies and
keeps the process alive for long-running commands.

[Docs](https://docs.lesto.run) · [Agent-readable docs](https://docs.lesto.run/llms.txt)
