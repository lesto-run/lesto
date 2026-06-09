import Database from "better-sqlite3";
import { installSchema, Queue } from "@keel/queue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  defaultUrlGuard,
  EVENT_HEADER,
  sign,
  SIGNATURE_HEADER,
  systemResolver,
  verify,
  WebhookError,
  Webhooks,
} from "../src/index";

import type { SqlDatabase } from "@keel/queue";
import type { FetchLike, Resolver, SecretSource, WebhookResponse } from "../src/index";

interface Call {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

let raw: Database.Database;
let queue: Queue;
let calls: Call[];

function fakeFetch(response: WebhookResponse): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });

    return response;
  };
}

// A resolver that maps test hostnames to fixed IPs — no real DNS, no network.
function resolverFor(map: Record<string, readonly string[]>): Resolver {
  return async (hostname) => map[hostname] ?? [];
}

// Default: every test host resolves to a public address unless overridden.
const PUBLIC = "93.184.216.34"; // example.com
const publicResolver: Resolver = resolverFor({ "example.com": [PUBLIC] });

// A secrets source backed by an in-memory map, standing in for env/a vault.
function secretsFrom(map: Record<string, string>): SecretSource {
  return (secretId) => map[secretId];
}

// Read the raw, persisted payload TEXT straight from the queue table.
function rawPayload(id: number): string {
  const row = raw.prepare("SELECT payload FROM keel_jobs WHERE id = ?").get(id) as {
    payload: string;
  };

  return row.payload;
}

beforeEach(() => {
  raw = new Database(":memory:");
  const db = raw as unknown as SqlDatabase;
  installSchema(db);
  queue = new Queue({ db });
  calls = [];
});

afterEach(() => {
  raw.close();
});

describe("sign & verify", () => {
  it("signs deterministically and verifies", () => {
    expect(sign("body", "secret")).toBe(sign("body", "secret"));

    const signature = sign("body", "secret");
    expect(verify("body", signature, "secret")).toBe(true);
    expect(verify("body", sign("body", "other"), "secret")).toBe(false); // same length, wrong mac
    expect(verify("body", "short", "secret")).toBe(false); // length mismatch short-circuits
  });
});

describe("Webhooks delivery", () => {
  it("signs and POSTs, resolving the secret from a reference at delivery time", async () => {
    const hooks = new Webhooks({
      queue,
      fetch: fakeFetch({ ok: true, status: 200 }),
      resolver: publicResolver,
      secrets: secretsFrom({ "ep-1": "shh" }),
    });
    hooks.send("https://example.com/hook", "order.paid", { id: 42 }, { secretId: "ep-1" });

    expect((await queue.runOnce())?.outcome).toBe("done");

    const call = calls[0];
    expect(call?.url).toBe("https://example.com/hook");
    expect(call?.init.headers[EVENT_HEADER]).toBe("order.paid");
    expect(call?.init.headers[SIGNATURE_HEADER]).toBe(sign(call?.init.body ?? "", "shh"));
    expect(verify(call?.init.body ?? "", call?.init.headers[SIGNATURE_HEADER] ?? "", "shh")).toBe(
      true,
    );
  });

  it("NEVER persists the raw secret — only a secretId reference is stored", async () => {
    const hooks = new Webhooks({
      queue,
      fetch: fakeFetch({ ok: true, status: 200 }),
      resolver: publicResolver,
      secrets: secretsFrom({ "ep-1": "super-secret-value" }),
    });
    const id = hooks.send(
      "https://example.com/hook",
      "order.paid",
      { id: 42 },
      { secretId: "ep-1" },
    );

    // The persisted queue row must contain the reference but not the secret.
    const persisted = rawPayload(id);
    expect(persisted).toContain("ep-1");
    expect(persisted).not.toContain("super-secret-value");

    // ...and the signature still comes out valid once delivered.
    await queue.runOnce();
    expect(
      verify(
        calls[0]?.init.body ?? "",
        calls[0]?.init.headers[SIGNATURE_HEADER] ?? "",
        "super-secret-value",
      ),
    ).toBe(true);
  });

  it("omits the signature when no secretId is given", async () => {
    const hooks = new Webhooks({
      queue,
      fetch: fakeFetch({ ok: true, status: 200 }),
      resolver: publicResolver,
    });
    hooks.send("https://example.com/hook", "ping", { ok: true });

    await queue.runOnce();
    expect(calls[0]?.init.headers[SIGNATURE_HEADER]).toBeUndefined();
  });

  it("fails (coded) and retries on a non-2xx response", async () => {
    const hooks = new Webhooks({
      queue,
      fetch: fakeFetch({ ok: false, status: 503 }),
      resolver: publicResolver,
    });
    const id = hooks.send("https://example.com/hook", "ping", {}, { maxAttempts: 1 });

    expect((await queue.runOnce())?.outcome).toBe("failed");
    expect(queue.find(id)?.lastError).toContain("returned 503");
  });

  it("defaults to the global fetch when none is injected", () => {
    const hooks = new Webhooks({ queue });

    expect(typeof hooks.send).toBe("function"); // constructed against globalThis.fetch
  });

  it("WebhookError carries a frozen, coded payload", () => {
    const error = new WebhookError("WEBHOOK_DELIVERY_FAILED", "boom", { status: 500 });

    expect(error.code).toBe("WEBHOOK_DELIVERY_FAILED");
    expect(Object.isFrozen(error.details)).toBe(true);
  });
});

describe("Webhooks secret resolution failures", () => {
  it("fails loud when a secretId is set but no secrets source is configured", async () => {
    const hooks = new Webhooks({
      queue,
      fetch: fakeFetch({ ok: true, status: 200 }),
      resolver: publicResolver,
    });
    const id = hooks.send(
      "https://example.com/hook",
      "ping",
      {},
      { secretId: "ep-1", maxAttempts: 1 },
    );

    expect((await queue.runOnce())?.outcome).toBe("failed");
    expect(queue.find(id)?.lastError).toContain("no secrets source");
    expect(calls).toHaveLength(0); // never sent an unsigned request
  });

  it("fails loud when the secrets source has no secret for the id", async () => {
    const hooks = new Webhooks({
      queue,
      fetch: fakeFetch({ ok: true, status: 200 }),
      resolver: publicResolver,
      secrets: secretsFrom({}),
    });
    const id = hooks.send(
      "https://example.com/hook",
      "ping",
      {},
      { secretId: "missing", maxAttempts: 1 },
    );

    expect((await queue.runOnce())?.outcome).toBe("failed");
    expect(queue.find(id)?.lastError).toContain("No secret is registered");
  });
});

describe("SSRF guard — defaultUrlGuard", () => {
  const rebindResolver = resolverFor({
    // A name that resolves to BOTH a public and a private IP (DNS rebinding).
    "rebind.example.com": [PUBLIC, "10.0.0.5"],
    "internal.example.com": ["10.1.2.3"],
  });

  it("permits a normal public host", async () => {
    expect(await defaultUrlGuard("https://example.com/hook", publicResolver)).toBeUndefined();
  });

  it("blocks the cloud metadata endpoint 169.254.169.254", async () => {
    expect(
      await defaultUrlGuard("http://169.254.169.254/latest/meta-data/", publicResolver),
    ).toMatch(/private\/reserved/);
  });

  it("blocks loopback 127.0.0.1 and localhost", async () => {
    expect(await defaultUrlGuard("http://127.0.0.1:8080/", publicResolver)).toMatch(/private/);
    expect(await defaultUrlGuard("http://localhost/", publicResolver)).toMatch(/localhost/);
  });

  it("blocks RFC1918 10.x and 192.168.x literals", async () => {
    expect(await defaultUrlGuard("http://10.0.0.5/", publicResolver)).toMatch(/private/);
    expect(await defaultUrlGuard("http://192.168.1.1/", publicResolver)).toMatch(/private/);
    expect(await defaultUrlGuard("http://172.16.0.1/", publicResolver)).toMatch(/private/);
  });

  it("blocks IPv6 loopback ::1 and link-local", async () => {
    expect(await defaultUrlGuard("http://[::1]/", publicResolver)).toMatch(/private/);
    expect(await defaultUrlGuard("http://[fe80::1]/", publicResolver)).toMatch(/private/);
  });

  it("blocks an IPv4-mapped IPv6 private address (hex form, as URL normalizes it)", async () => {
    // new URL("[::ffff:10.0.0.1]") normalizes the host to ::ffff:a00:1.
    expect(await defaultUrlGuard("http://[::ffff:10.0.0.1]/", publicResolver)).toMatch(/private/);
  });

  it("blocks an IPv4-mapped IPv6 private address (dotted form, via a resolver)", async () => {
    // A resolver may hand back the dotted ::ffff:a.b.c.d spelling directly.
    const mapped = resolverFor({ "mapped.example.com": ["::ffff:192.168.0.1"] });
    expect(await defaultUrlGuard("https://mapped.example.com/", mapped)).toMatch(/private/);
  });

  it("blocks non-http(s) schemes", async () => {
    expect(await defaultUrlGuard("file:///etc/passwd", publicResolver)).toMatch(/scheme/);
    expect(await defaultUrlGuard("gopher://example.com/", publicResolver)).toMatch(/scheme/);
  });

  it("blocks an unparseable URL", async () => {
    expect(await defaultUrlGuard("not a url", publicResolver)).toMatch(/not parseable/);
  });

  it("blocks a host that does not resolve", async () => {
    expect(await defaultUrlGuard("https://nowhere.example.com/", publicResolver)).toMatch(
      /did not resolve/,
    );
  });

  it("blocks a name that resolves to a private address (DNS rebinding)", async () => {
    expect(await defaultUrlGuard("https://internal.example.com/", rebindResolver)).toMatch(
      /private\/reserved/,
    );
    // Even if one record is public, a single private record blocks the whole host.
    expect(await defaultUrlGuard("https://rebind.example.com/", rebindResolver)).toMatch(
      /private\/reserved/,
    );
  });

  it("blocks the unspecified addresses 0.0.0.0 and ::", async () => {
    expect(await defaultUrlGuard("http://0.0.0.0/", publicResolver)).toMatch(/private/);
    expect(await defaultUrlGuard("http://[::]/", publicResolver)).toMatch(/private/);
  });

  it("blocks carrier-grade NAT and multicast/reserved ranges", async () => {
    expect(await defaultUrlGuard("http://100.64.0.1/", publicResolver)).toMatch(/private/);
    expect(await defaultUrlGuard("http://224.0.0.1/", publicResolver)).toMatch(/private/);
  });

  it("blocks IPv6 unique-local fc00::/7", async () => {
    expect(await defaultUrlGuard("http://[fc00::1]/", publicResolver)).toMatch(/private/);
    expect(await defaultUrlGuard("http://[fd12:3456::1]/", publicResolver)).toMatch(/private/);
  });

  it("blocks UNCOMPRESSED IPv6 private forms returned by a resolver (canonicalization)", async () => {
    // A custom/injected resolver or a hostile DNS server can hand back a
    // non-normalized spelling. Without canonicalization, "0:0:0:0:0:0:0:1"
    // would slip past the `=== "::1"` check and reach IPv6 loopback.
    const sneaky = resolverFor({
      "loop.example.com": ["0:0:0:0:0:0:0:1"], // uncompressed ::1
      "unspec.example.com": ["0:0:0:0:0:0:0:0"], // uncompressed ::
      "mapped.example.com": ["0:0:0:0:0:ffff:a00:1"], // uncompressed ::ffff:10.0.0.1
      "ll.example.com": ["fe80:0:0:0:0:0:0:1"], // uncompressed link-local
    });

    expect(await defaultUrlGuard("https://loop.example.com/", sneaky)).toMatch(/private/);
    expect(await defaultUrlGuard("https://unspec.example.com/", sneaky)).toMatch(/private/);
    expect(await defaultUrlGuard("https://mapped.example.com/", sneaky)).toMatch(/private/);
    expect(await defaultUrlGuard("https://ll.example.com/", sneaky)).toMatch(/private/);
  });

  it("blocks a zone-scoped link-local literal (canonicalization falls back, still refused)", async () => {
    // "fe80::1%eth0" is a valid IPv6 per isIP but the zone id makes `new URL`
    // throw — canonicalization falls back to the raw input, whose fe80 prefix
    // still trips the link-local block. A resolver may hand back scoped forms.
    const scoped = resolverFor({ "zone.example.com": ["fe80::1%eth0"] });
    expect(await defaultUrlGuard("https://zone.example.com/", scoped)).toMatch(/private/);
  });

  it("permits a public IPv6 literal", async () => {
    expect(await defaultUrlGuard("http://[2606:4700:4700::1111]/", publicResolver)).toBeUndefined();
  });

  it("refuses a host that resolves to something that is not a recognizable IP", async () => {
    const bogus = resolverFor({ "weird.example.com": ["not-an-ip"] });
    expect(await defaultUrlGuard("https://weird.example.com/", bogus)).toMatch(/private\/reserved/);
  });
});

describe("systemResolver", () => {
  it("resolves localhost to at least one loopback address (offline-safe)", async () => {
    const addresses = await systemResolver("localhost");

    expect(addresses.length).toBeGreaterThan(0);
    // localhost always maps to a loopback (127.0.0.1 or ::1).
    expect(addresses.every((ip) => ip === "127.0.0.1" || ip === "::1")).toBe(true);
  });
});

describe("Webhooks SSRF integration", () => {
  it("refuses to deliver to a blocked URL and surfaces a coded failure", async () => {
    const hooks = new Webhooks({
      queue,
      fetch: fakeFetch({ ok: true, status: 200 }),
      resolver: publicResolver,
    });
    const id = hooks.send("http://169.254.169.254/latest/", "steal", {}, { maxAttempts: 1 });

    expect((await queue.runOnce())?.outcome).toBe("failed");
    expect(queue.find(id)?.lastError).toContain("Refusing to deliver");
    expect(calls).toHaveLength(0); // fetch never called
  });

  it("honors an injected urlGuard for legit internal delivery", async () => {
    const hooks = new Webhooks({
      queue,
      fetch: fakeFetch({ ok: true, status: 200 }),
      resolver: resolverFor({ "internal.svc": ["10.0.0.9"] }),
      urlGuard: async () => undefined, // allow everything (e.g. inside a trusted mesh)
    });
    hooks.send("http://internal.svc/hook", "ping", {});

    expect((await queue.runOnce())?.outcome).toBe("done");
    expect(calls).toHaveLength(1);
  });

  it("uses the default urlGuard when none is injected (still blocks private)", async () => {
    // No urlGuard option -> defaultUrlGuard wired in; a literal private IP blocks.
    const hooks = new Webhooks({
      queue,
      fetch: fakeFetch({ ok: true, status: 200 }),
    });
    const id = hooks.send("http://10.0.0.1/hook", "ping", {}, { maxAttempts: 1 });

    expect((await queue.runOnce())?.outcome).toBe("failed");
    expect(queue.find(id)?.lastError).toContain("Refusing to deliver");
  });
});
