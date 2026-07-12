# @lesto/storage

> Lesto's object storage — a pluggable backend (S3/R2 for production; in-memory and local filesystem for dev).

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/storage
```

```ts
import { Storage, MemoryBackend, S3Backend } from "@lesto/storage";

// Dev: in-memory (nothing survives a restart).
const storage = new Storage(new MemoryBackend());
await storage.putText("greeting.txt", "hello");
await storage.getText("greeting.txt"); // "hello"

// Production: S3 / R2 / MinIO over fetch + SigV4 — runs unchanged on Workers.
const cloud = new Storage(
  new S3Backend({ endpoint, bucket, region, accessKeyId, secretAccessKey }),
);
await cloud.url("avatars/me.png", { expiresInSeconds: 300 }); // presigned
```

[Docs](https://docs.lesto.run/batteries/storage) · [Agent-readable docs](https://docs.lesto.run/llms.txt)
