import { createHmac } from "node:crypto";

import Database from "better-sqlite3";
import { installSchema, Queue } from "@lesto/queue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_TOLERANCE_MS,
  defaultUrlGuard,
  EVENT_HEADER,
  sign,
  SIGNATURE_HEADER,
  systemResolver,
  TIMESTAMP_HEADER,
  TRACEPARENT_HEADER,
  verify,
  verifyRequest,
  WebhookError,
  Webhooks,
} from "../src/index";

import type { SqlDatabase } from "@lesto/queue";
import type {
  FetchLike,
  Resolver,
  SecretResolver,
  SecretResolverContext,
  SecretSource,
  VerifyRequestInput,
  WebhookResponse,
} from "../src/index";

// Await a promise expected to REJECT and return its rejection. Throws if it
// resolves — so a "fails closed" assertion can never pass vacuously.
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("expected the promise to reject, but it resolved.");
}

interface Call {
  url: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    redirect?: "manual";
  };
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

// The signature + timestamp headers a deliverer would send for `body`, signed
// under `sec` — mirrors what `Webhooks`'s private `deliver` produces.
function signedHeaders(ts: number, body: string, sec: string): Record<string, string> {
  return {
    [SIGNATURE_HEADER]: sign(`${ts}.${body}`, sec),
    [TIMESTAMP_HEADER]: String(ts),
  };
}

// Read the raw, persisted payload TEXT straight from the queue table.
function rawPayload(id: number): string {
  const row = raw.prepare("SELECT payload FROM lesto_jobs WHERE id = ?").get(id) as {
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

  it("binds a timestamp and rejects a replay outside tolerance (blocker #3)", () => {
    const ts = 1_700_000_000_000;
    const signature = sign(`${ts}.body`, "secret"); // what the deliverer signs

    // Captured request, verified within tolerance: accepted.
    expect(verify("body", signature, "secret", { timestamp: ts, now: ts + 1000 })).toBe(true);

    // The SAME captured request replayed past the window: rejected, despite a
    // valid signature, before any HMAC is even computed.
    const replayedAt = ts + DEFAULT_TOLERANCE_MS + 1;
    expect(verify("body", signature, "secret", { timestamp: ts, now: replayedAt })).toBe(false);

    // A custom (tighter) tolerance also rejects.
    expect(
      verify("body", signature, "secret", { timestamp: ts, now: ts + 2000, toleranceMs: 1000 }),
    ).toBe(false);

    // Within tolerance but a forged body still fails the signature check.
    expect(verify("tampered", signature, "secret", { timestamp: ts, now: ts })).toBe(false);

    // No `now` given: it defaults to Date.now(). A just-now timestamp is in window.
    const fresh = Date.now();
    expect(verify("body", sign(`${fresh}.body`, "secret"), "secret", { timestamp: fresh })).toBe(
      true,
    );
  });
});

describe("verifyRequest", () => {
  const secret = "shh";

  it("fails with missing_signature when the signature header is absent", () => {
    const result = verifyRequest(
      { body: "{}", headers: { [TIMESTAMP_HEADER]: "123" } },
      { secret },
    );

    expect(result).toEqual({ verified: false, reason: "missing_signature" });
  });

  it("fails with missing_timestamp when the timestamp header is absent", () => {
    const result = verifyRequest(
      { body: "{}", headers: { [SIGNATURE_HEADER]: "deadbeef" } },
      { secret },
    );

    expect(result).toEqual({ verified: false, reason: "missing_timestamp" });
  });

  it("fails with malformed_timestamp when the timestamp header is not a finite number", () => {
    const notANumber = verifyRequest(
      {
        body: "{}",
        headers: { [SIGNATURE_HEADER]: "deadbeef", [TIMESTAMP_HEADER]: "not-a-number" },
      },
      { secret },
    );
    expect(notANumber).toEqual({ verified: false, reason: "malformed_timestamp" });

    const infinite = verifyRequest(
      {
        body: "{}",
        headers: { [SIGNATURE_HEADER]: "deadbeef", [TIMESTAMP_HEADER]: "Infinity" },
      },
      { secret },
    );
    expect(infinite).toEqual({ verified: false, reason: "malformed_timestamp" });
  });

  it("fails with stale_timestamp when outside the tolerance window (distinct from a bad signature)", () => {
    const ts = 1_700_000_000_000;
    const body = JSON.stringify({ event: "order.paid", data: {} });
    const headers = signedHeaders(ts, body, secret); // a VALID signature, just old

    const result = verifyRequest({ body, headers }, { secret, now: ts + DEFAULT_TOLERANCE_MS + 1 });

    expect(result).toEqual({ verified: false, reason: "stale_timestamp" });
  });

  it("honors a custom toleranceMs for staleness", () => {
    const ts = 1_700_000_000_000;
    const body = JSON.stringify({ event: "order.paid", data: {} });
    const headers = signedHeaders(ts, body, secret);

    // Within the default tolerance, but past a tighter custom one.
    const result = verifyRequest({ body, headers }, { secret, now: ts + 2000, toleranceMs: 1000 });

    expect(result).toEqual({ verified: false, reason: "stale_timestamp" });
  });

  it("fails with signature_mismatch on a forged/tampered signature within tolerance", () => {
    const ts = 1_700_000_000_000;
    const body = JSON.stringify({ event: "order.paid", data: {} });
    const headers = signedHeaders(ts, body, "wrong-secret");

    const result = verifyRequest({ body, headers }, { secret, now: ts });

    expect(result).toEqual({ verified: false, reason: "signature_mismatch" });
  });

  it("verifies and extracts the event from the SIGNED body (never the unsigned event header)", () => {
    const ts = 1_700_000_000_000;
    const body = JSON.stringify({ event: "order.paid", data: { id: 42 } });
    const headers = {
      ...signedHeaders(ts, body, secret),
      [EVENT_HEADER]: "spoofed.event", // unsigned — must be ignored
    };

    const result = verifyRequest({ body, headers }, { secret, now: ts });

    expect(result).toEqual({ verified: true, event: "order.paid" });
  });

  it("verifies a signed NON-JSON body without throwing, event undefined", () => {
    const ts = 1_700_000_000_000;
    const body = "not json at all";
    const headers = signedHeaders(ts, body, secret);

    const result = verifyRequest({ body, headers }, { secret, now: ts });

    expect(result).toEqual({ verified: true });
    expect(result.event).toBeUndefined();
  });

  it("verifies a signed JSON `null` body without throwing, event undefined", () => {
    const ts = 1_700_000_000_000;
    const body = "null";
    const headers = signedHeaders(ts, body, secret);

    const result = verifyRequest({ body, headers }, { secret, now: ts });

    expect(result).toEqual({ verified: true });
    expect(result.event).toBeUndefined();
  });

  it("verifies a signed JSON array body without throwing, event undefined (not an object)", () => {
    const ts = 1_700_000_000_000;
    const body = JSON.stringify([1, 2, 3]);
    const headers = signedHeaders(ts, body, secret);

    const result = verifyRequest({ body, headers }, { secret, now: ts });

    expect(result).toEqual({ verified: true });
    expect(result.event).toBeUndefined();
  });

  it("verifies a signed JSON object body with a non-string event, event undefined", () => {
    const ts = 1_700_000_000_000;
    const body = JSON.stringify({ event: 123, data: {} });
    const headers = signedHeaders(ts, body, secret);

    const result = verifyRequest({ body, headers }, { secret, now: ts });

    expect(result).toEqual({ verified: true });
    expect(result.event).toBeUndefined();
  });

  it("defaults now/toleranceMs to Date.now()/DEFAULT_TOLERANCE_MS when not provided", () => {
    const ts = Date.now();
    const body = JSON.stringify({ event: "ping", data: {} });
    const headers = signedHeaders(ts, body, secret);

    // No `now`/`toleranceMs` given: a just-signed request verifies against the
    // real clock default.
    const result = verifyRequest({ body, headers }, { secret });

    expect(result).toEqual({ verified: true, event: "ping" });
  });
});

describe("verifyRequest — multi-tenant secret resolver", () => {
  const TENANT_HEADER = "x-tenant-id";
  const ts = 1_700_000_000_000;

  // Two tenants, two DISTINCT signing secrets — the whole point of the resolver.
  const secrets: Record<string, string> = { acme: "acme-secret", globex: "globex-secret" };

  // A request for `tenant` whose body is signed under THAT tenant's secret, with
  // the (untrusted-until-verified) tenant id in a header.
  function tenantRequest(tenant: string, body: string): VerifyRequestInput {
    return {
      body,
      headers: {
        ...signedHeaders(ts, body, secrets[tenant] as string),
        [TENANT_HEADER]: tenant,
      },
    };
  }

  // Picks the secret by the tenant header; an unknown tenant yields "" (fail closed).
  const byTenantHeader: SecretResolver = (ctx) => secrets[ctx.headers[TENANT_HEADER] ?? ""] ?? "";

  it("keeps the static-string path synchronous (returns a result, never a Promise)", () => {
    const body = JSON.stringify({ event: "order.paid", data: {} });

    const result = verifyRequest(
      { body, headers: signedHeaders(ts, body, "shh") },
      { secret: "shh", now: ts },
    );

    // Backward-compat lock: a static secret must NOT turn the call async.
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toEqual({ verified: true, event: "order.paid" });
  });

  it("verifies with a synchronous resolver (Promise-returning, resolves true)", async () => {
    const body = JSON.stringify({ event: "acme.created", data: { id: 1 } });

    const promise = verifyRequest(tenantRequest("acme", body), { secret: byTenantHeader, now: ts });

    // A resolver makes the call async even when the resolver itself is sync.
    expect(promise).toBeInstanceOf(Promise);
    expect(await promise).toEqual({ verified: true, event: "acme.created" });
  });

  it("verifies with an async resolver (Promise<string>)", async () => {
    const body = JSON.stringify({ event: "globex.paid", data: {} });
    const asyncResolver: SecretResolver = async (ctx) => {
      await Promise.resolve(); // a real lookup would await a DB/vault here
      return secrets[ctx.headers[TENANT_HEADER] ?? ""] as string;
    };

    expect(
      await verifyRequest(tenantRequest("globex", body), { secret: asyncResolver, now: ts }),
    ).toEqual({ verified: true, event: "globex.paid" });
  });

  it("resolves a DIFFERENT secret per tenant — both verify, a cross-signed body is rejected", async () => {
    const acmeBody = JSON.stringify({ event: "acme.created", data: {} });
    const globexBody = JSON.stringify({ event: "globex.created", data: {} });

    // Two tenants, each signed under its OWN secret: both verify through one receiver.
    expect(
      await verifyRequest(tenantRequest("acme", acmeBody), { secret: byTenantHeader, now: ts }),
    ).toEqual({ verified: true, event: "acme.created" });
    expect(
      await verifyRequest(tenantRequest("globex", globexBody), { secret: byTenantHeader, now: ts }),
    ).toEqual({ verified: true, event: "globex.created" });

    // A body that CLAIMS acme but was signed with globex's secret: the resolver
    // hands back acme's secret, so the HMAC does NOT match. Proof the resolver
    // truly selects per tenant — a single shared secret would wrongly accept this.
    const crossSigned: VerifyRequestInput = {
      body: acmeBody,
      headers: {
        ...signedHeaders(ts, acmeBody, secrets["globex"] as string),
        [TENANT_HEADER]: "acme",
      },
    };

    expect(await verifyRequest(crossSigned, { secret: byTenantHeader, now: ts })).toEqual({
      verified: false,
      reason: "signature_mismatch",
    });
  });

  it("passes the raw body, headers, and parsed timestamp to the resolver — never the signature", async () => {
    const body = JSON.stringify({ event: "ping", data: {} });
    const headers: Record<string, string> = {
      ...signedHeaders(ts, body, "shh"),
      [TENANT_HEADER]: "acme",
    };
    let seen: SecretResolverContext | undefined;
    const capturing: SecretResolver = (ctx) => {
      seen = ctx;

      return "shh";
    };

    expect(await verifyRequest({ body, headers }, { secret: capturing, now: ts })).toEqual({
      verified: true,
      event: "ping",
    });
    expect(seen?.body).toBe(body); // the RAW body, for tenant selection
    expect(seen?.headers[TENANT_HEADER]).toBe("acme");
    expect(seen?.timestamp).toBe(ts);
    // The resolver's job is SELECTING a secret, never verifying one — the
    // signature it has no legitimate use for must not be reachable at all.
    expect(seen).not.toHaveProperty("signature");
  });

  it("fails CLOSED (WEBHOOK_SECRET_UNRESOLVED) when the resolver throws, preserving the cause", async () => {
    const body = JSON.stringify({ event: "ping", data: {} });
    const boom = new Error("tenant lookup failed");
    const throwing: SecretResolver = () => {
      throw boom;
    };

    const error = await rejection(
      verifyRequest(
        { body, headers: signedHeaders(ts, body, "shh") },
        { secret: throwing, now: ts },
      ),
    );

    expect(error).toBeInstanceOf(WebhookError);
    expect((error as WebhookError).code).toBe("WEBHOOK_SECRET_UNRESOLVED");
    expect((error as WebhookError).details["cause"]).toBe(boom); // original preserved for debugging
  });

  it("fails CLOSED when the resolver returns an empty secret (unknown tenant)", async () => {
    const body = JSON.stringify({ event: "ping", data: {} });
    // "nobody" is not in the map -> byTenantHeader returns "" -> reject, never pass.
    const req: VerifyRequestInput = {
      body,
      headers: { ...signedHeaders(ts, body, "shh"), [TENANT_HEADER]: "nobody" },
    };

    const error = await rejection(verifyRequest(req, { secret: byTenantHeader, now: ts }));

    expect(error).toBeInstanceOf(WebhookError);
    expect((error as WebhookError).code).toBe("WEBHOOK_SECRET_UNRESOLVED");
  });

  it("fails CLOSED when a (mistyped) resolver hands back undefined", async () => {
    const body = JSON.stringify({ event: "ping", data: {} });
    // The type says `string`, but a JS caller can still return undefined; the
    // runtime guard must catch it rather than verifying against nothing.
    const returnsUndefined = (() => undefined) as unknown as SecretResolver;

    const error = await rejection(
      verifyRequest(
        { body, headers: signedHeaders(ts, body, "shh") },
        { secret: returnsUndefined, now: ts },
      ),
    );

    expect(error).toBeInstanceOf(WebhookError);
    expect((error as WebhookError).code).toBe("WEBHOOK_SECRET_UNRESOLVED");
  });

  it("returns the pre-check verdict WITHOUT invoking the resolver when a header is missing", async () => {
    let called = false;
    const resolver: SecretResolver = () => {
      called = true;

      return "shh";
    };

    // No signature header: the cheap pre-check short-circuits before any secret work.
    const result = await verifyRequest(
      { body: "{}", headers: { [TIMESTAMP_HEADER]: String(ts) } },
      { secret: resolver, now: ts },
    );

    expect(result).toEqual({ verified: false, reason: "missing_signature" });
    expect(called).toBe(false); // an obviously-bad request never triggers a lookup
  });
});

describe("byte-exact Uint8Array bodies (binary-webhook HMAC)", () => {
  const secret = "shh";

  // Deliberately NOT valid UTF-8: a bare continuation byte (0x80) and a lead
  // byte (0xc3) followed by a non-continuation byte. Decoding this through a
  // string and re-encoding replaces the invalid bytes with U+FFFD, so it is
  // NOT round-trippable — the sharpest possible witness that a body was
  // hashed byte-for-byte and not silently coerced through a string somewhere
  // in the path. Asserted once here, then relied on below.
  const body = Uint8Array.from([0xff, 0x80, 0x00, 0xc3, 0x28]);

  it("is confirmed non-UTF-8-safe: a decode+re-encode round trip corrupts it", () => {
    const reencoded = new TextEncoder().encode(new TextDecoder().decode(body));

    expect(reencoded).not.toEqual(body);
  });

  it("sign/verify hash a Uint8Array body directly, matching an independent node HMAC", () => {
    const signature = sign(body, secret);
    const expected = createHmac("sha256", secret).update(body).digest("hex");

    expect(signature).toBe(expected);
    expect(verify(body, signature, secret)).toBe(true);

    // Tamper one byte: the same signature must now fail.
    const tampered = Uint8Array.from(body);
    tampered[0] = 0x01;
    expect(verify(tampered, signature, secret)).toBe(false);
  });

  it("verify binds a timestamp over the raw bytes (prefix + body, never a decoded string)", () => {
    const ts = 1_700_000_000_000;

    // What a byte-exact deliverer signs: the ASCII `${timestamp}.` prefix
    // concatenated with the RAW body bytes — computed independently here via
    // node's own createHmac, never through @lesto/webhooks's internals.
    const prefix = Buffer.from(`${ts}.`, "utf8");
    const signedBytes = new Uint8Array(prefix.length + body.length);
    signedBytes.set(prefix, 0);
    signedBytes.set(body, prefix.length);
    const signature = createHmac("sha256", secret).update(signedBytes).digest("hex");

    expect(verify(body, signature, secret, { timestamp: ts, now: ts })).toBe(true);

    // A signature computed over a DECODED-then-re-encoded body must NOT verify
    // against the original bytes — proof the timestamp-bound path is also
    // byte-exact, not just the untimestamped one.
    const lossyBytes = new TextEncoder().encode(new TextDecoder().decode(body));
    const lossySignedBytes = new Uint8Array(prefix.length + lossyBytes.length);
    lossySignedBytes.set(prefix, 0);
    lossySignedBytes.set(lossyBytes, prefix.length);
    const lossySignature = createHmac("sha256", secret).update(lossySignedBytes).digest("hex");

    expect(verify(body, lossySignature, secret, { timestamp: ts, now: ts })).toBe(false);
  });

  it("verifyRequest verifies a binary VerifyRequestInput.body over its raw bytes", () => {
    const ts = 1_700_000_000_000;
    const prefix = Buffer.from(`${ts}.`, "utf8");
    const signedBytes = new Uint8Array(prefix.length + body.length);
    signedBytes.set(prefix, 0);
    signedBytes.set(body, prefix.length);
    const signature = createHmac("sha256", secret).update(signedBytes).digest("hex");

    const headers = { [SIGNATURE_HEADER]: signature, [TIMESTAMP_HEADER]: String(ts) };

    // `VerifyRequestInput.body` must accept a `Uint8Array` for this literal to
    // typecheck — reverting the widening turns this into a compile error, not
    // just a runtime failure. That is the whole point of this task.
    const input: VerifyRequestInput = { body, headers };

    const result = verifyRequest(input, { secret, now: ts });

    // The bytes aren't valid JSON, so no `event` — but verified all the same.
    expect(result).toEqual({ verified: true });
  });

  it("extracts the event from a valid-UTF-8 JSON Uint8Array body (the decode-then-extract arm)", () => {
    // The binary tests above never carry a parseable envelope, so the success
    // path that decodes bytes -> UTF-8 -> JSON to surface `event` had no witness.
    // A valid-UTF-8 JSON body IS byte-exact, so verification AND event extraction
    // both run over the raw bytes.
    const ts = 1_700_000_000_000;
    const jsonBody = new TextEncoder().encode('{"event":"order.created","data":{"id":7}}');

    const prefix = Buffer.from(`${ts}.`, "utf8");
    const signedBytes = new Uint8Array(prefix.length + jsonBody.length);
    signedBytes.set(prefix, 0);
    signedBytes.set(jsonBody, prefix.length);
    const signature = createHmac("sha256", secret).update(signedBytes).digest("hex");

    const headers = { [SIGNATURE_HEADER]: signature, [TIMESTAMP_HEADER]: String(ts) };
    const result = verifyRequest({ body: jsonBody, headers }, { secret, now: ts });

    expect(result).toEqual({ verified: true, event: "order.created" });
  });

  it("verifyRequest rejects a binary body when the signature was computed over DIFFERENT bytes", () => {
    const ts = 1_700_000_000_000;
    const tampered = Uint8Array.from(body);
    tampered[0] = 0x01;

    const prefix = Buffer.from(`${ts}.`, "utf8");
    const signedBytes = new Uint8Array(prefix.length + tampered.length);
    signedBytes.set(prefix, 0);
    signedBytes.set(tampered, prefix.length);
    const signature = createHmac("sha256", secret).update(signedBytes).digest("hex");

    const headers = { [SIGNATURE_HEADER]: signature, [TIMESTAMP_HEADER]: String(ts) };

    const result = verifyRequest({ body, headers }, { secret, now: ts });

    expect(result).toEqual({ verified: false, reason: "signature_mismatch" });
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
    await hooks.send("https://example.com/hook", "order.paid", { id: 42 }, { secretId: "ep-1" });

    expect((await queue.runOnce())?.outcome).toBe("done");

    const call = calls[0];
    expect(call?.url).toBe("https://example.com/hook");
    expect(call?.init.headers[EVENT_HEADER]).toBe("order.paid");
    expect(call?.init.redirect).toBe("manual"); // SSRF: never follow a redirect past the guard

    // The signature binds the shipped x-lesto-timestamp (replay defense): it is the
    // HMAC of `${timestamp}.${body}`, and verify() accepts it under that timestamp.
    const timestamp = Number(call?.init.headers[TIMESTAMP_HEADER]);
    expect(Number.isFinite(timestamp)).toBe(true);
    expect(call?.init.headers[SIGNATURE_HEADER]).toBe(
      sign(`${timestamp}.${call?.init.body ?? ""}`, "shh"),
    );
    expect(
      verify(call?.init.body ?? "", call?.init.headers[SIGNATURE_HEADER] ?? "", "shh", {
        timestamp,
        now: timestamp,
      }),
    ).toBe(true);
  });

  it("NEVER persists the raw secret — only a secretId reference is stored", async () => {
    const hooks = new Webhooks({
      queue,
      fetch: fakeFetch({ ok: true, status: 200 }),
      resolver: publicResolver,
      secrets: secretsFrom({ "ep-1": "super-secret-value" }),
    });
    const id = await hooks.send(
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
    const timestamp = Number(calls[0]?.init.headers[TIMESTAMP_HEADER]);
    expect(
      verify(
        calls[0]?.init.body ?? "",
        calls[0]?.init.headers[SIGNATURE_HEADER] ?? "",
        "super-secret-value",
        { timestamp, now: timestamp },
      ),
    ).toBe(true);
  });

  it("omits the signature when no secretId is given", async () => {
    const hooks = new Webhooks({
      queue,
      fetch: fakeFetch({ ok: true, status: 200 }),
      resolver: publicResolver,
    });
    await hooks.send("https://example.com/hook", "ping", { ok: true });

    await queue.runOnce();
    expect(calls[0]?.init.headers[SIGNATURE_HEADER]).toBeUndefined();
  });

  it("captures the traceparent at send time, carries it on the payload, and emits it on delivery", async () => {
    const captured = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    const hooks = new Webhooks({
      queue,
      fetch: fakeFetch({ ok: true, status: 200 }),
      resolver: publicResolver,
      // The source captures at SEND time (here, a fixed value standing in for the
      // request's in-flight trace); the worker emits it later at delivery.
      traceparent: () => captured,
    });

    const id = await hooks.send("https://example.com/hook", "ping", { ok: true });

    // The trace id rode the persisted payload (it is a propagation id, not a secret).
    expect(rawPayload(id)).toContain(captured);

    await queue.runOnce();

    // The deliverer forwarded it verbatim on the outbound POST.
    expect(calls[0]?.init.headers[TRACEPARENT_HEADER]).toBe(captured);
  });

  it("emits no traceparent when the source returns undefined (no active trace)", async () => {
    const hooks = new Webhooks({
      queue,
      fetch: fakeFetch({ ok: true, status: 200 }),
      resolver: publicResolver,
      traceparent: () => undefined,
    });

    const id = await hooks.send("https://example.com/hook", "ping", { ok: true });

    expect(rawPayload(id)).not.toContain(TRACEPARENT_HEADER);

    await queue.runOnce();

    expect(calls[0]?.init.headers[TRACEPARENT_HEADER]).toBeUndefined();
  });

  it("emits no traceparent when no source is configured at all (the untraced default)", async () => {
    const hooks = new Webhooks({
      queue,
      fetch: fakeFetch({ ok: true, status: 200 }),
      resolver: publicResolver,
    });

    await hooks.send("https://example.com/hook", "ping", { ok: true });

    await queue.runOnce();

    expect(calls[0]?.init.headers[TRACEPARENT_HEADER]).toBeUndefined();
  });

  it("fails (coded) and retries on a non-2xx response", async () => {
    const hooks = new Webhooks({
      queue,
      fetch: fakeFetch({ ok: false, status: 503 }),
      resolver: publicResolver,
    });
    const id = await hooks.send("https://example.com/hook", "ping", {}, { maxAttempts: 1 });

    expect((await queue.runOnce())?.outcome).toBe("failed");
    expect((await queue.find(id))?.lastError).toContain("returned 503");
  });

  it("refuses to follow a 302 to a metadata endpoint after the guard ran (blocker #3)", async () => {
    // The destination is a guarded PUBLIC URL, but it answers 302 →
    // 169.254.169.254. With redirect:"manual" the fetch never follows; the 3xx
    // surfaces as a coded delivery failure instead of an SSRF to the metadata host.
    const redirecting: FetchLike = async (url, init) => {
      calls.push({ url, init });

      return { ok: false, status: 302 };
    };

    const hooks = new Webhooks({
      queue,
      fetch: redirecting,
      resolver: publicResolver,
    });
    const id = await hooks.send("https://example.com/hook", "ping", {}, { maxAttempts: 1 });

    expect((await queue.runOnce())?.outcome).toBe("failed");
    expect(calls[0]?.init.redirect).toBe("manual"); // asked the transport not to follow
    expect((await queue.find(id))?.lastError).toContain("redirected (302)");
    expect((await queue.find(id))?.lastError).toContain("SSRF guard");
    // Exactly one call — the redirect was NOT followed to a second (private) host.
    expect(calls).toHaveLength(1);
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
    const id = await hooks.send(
      "https://example.com/hook",
      "ping",
      {},
      { secretId: "ep-1", maxAttempts: 1 },
    );

    expect((await queue.runOnce())?.outcome).toBe("failed");
    expect((await queue.find(id))?.lastError).toContain("no secrets source");
    expect(calls).toHaveLength(0); // never sent an unsigned request
  });

  it("fails loud when the secrets source has no secret for the id", async () => {
    const hooks = new Webhooks({
      queue,
      fetch: fakeFetch({ ok: true, status: 200 }),
      resolver: publicResolver,
      secrets: secretsFrom({}),
    });
    const id = await hooks.send(
      "https://example.com/hook",
      "ping",
      {},
      { secretId: "missing", maxAttempts: 1 },
    );

    expect((await queue.runOnce())?.outcome).toBe("failed");
    expect((await queue.find(id))?.lastError).toContain("No secret is registered");
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
    const id = await hooks.send("http://169.254.169.254/latest/", "steal", {}, { maxAttempts: 1 });

    expect((await queue.runOnce())?.outcome).toBe("failed");
    expect((await queue.find(id))?.lastError).toContain("Refusing to deliver");
    expect(calls).toHaveLength(0); // fetch never called
  });

  it("honors an injected urlGuard for legit internal delivery", async () => {
    const hooks = new Webhooks({
      queue,
      fetch: fakeFetch({ ok: true, status: 200 }),
      resolver: resolverFor({ "internal.svc": ["10.0.0.9"] }),
      urlGuard: async () => undefined, // allow everything (e.g. inside a trusted mesh)
    });
    await hooks.send("http://internal.svc/hook", "ping", {});

    expect((await queue.runOnce())?.outcome).toBe("done");
    expect(calls).toHaveLength(1);
  });

  it("uses the default urlGuard when none is injected (still blocks private)", async () => {
    // No urlGuard option -> defaultUrlGuard wired in; a literal private IP blocks.
    const hooks = new Webhooks({
      queue,
      fetch: fakeFetch({ ok: true, status: 200 }),
    });
    const id = await hooks.send("http://10.0.0.1/hook", "ping", {}, { maxAttempts: 1 });

    expect((await queue.runOnce())?.outcome).toBe("failed");
    expect((await queue.find(id))?.lastError).toContain("Refusing to deliver");
  });

  it("a blocked URL fails PERMANENTLY after one attempt, never burning maxAttempts", async () => {
    // maxAttempts is high (5), but a blocked URL can never succeed on a retry —
    // it resolves to the same private/reserved address every time. The deliverer
    // marks the failure permanent (`permanentFailure`), so the queue retires the
    // job to `failed` after THIS attempt instead of scheduling four more doomed
    // retries.
    const hooks = new Webhooks({
      queue,
      fetch: fakeFetch({ ok: true, status: 200 }),
      resolver: publicResolver,
    });
    const id = await hooks.send("http://169.254.169.254/latest/", "steal", {}, { maxAttempts: 5 });

    const result = await queue.runOnce();

    expect(result?.outcome).toBe("failed"); // NOT "retry"
    const job = await queue.find(id);
    expect(job?.status).toBe("failed");
    expect(job?.attempts).toBe(1); // one attempt, not 5
    expect(job?.lastError).toContain("Refusing to deliver");
    expect(calls).toHaveLength(0); // fetch never called
  });

  it("a TRANSIENT delivery failure still retries under maxAttempts (unchanged)", async () => {
    // Contrast: a real non-2xx from a public host is NOT permanent — the receiver
    // might recover — so it retries as before. Proof the permanent signal is
    // scoped to the blocked-URL path and did not make every failure terminal.
    const hooks = new Webhooks({
      queue,
      fetch: fakeFetch({ ok: false, status: 503 }),
      resolver: publicResolver,
    });
    const id = await hooks.send("https://example.com/hook", "ping", {}, { maxAttempts: 5 });

    const result = await queue.runOnce();

    expect(result?.outcome).toBe("retry"); // still retries
    const job = await queue.find(id);
    expect(job?.status).toBe("ready");
    expect(job?.attempts).toBe(1); // attempt 1 of 5 — four remain
  });
});
