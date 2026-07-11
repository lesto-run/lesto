import { describe, expect, it } from "vitest";

import { S3Backend, Storage, StorageError } from "../src/index";

import type { S3BackendOptions } from "../src/index";

type FetchArgs = Parameters<typeof fetch>;
type FetchBody = NonNullable<FetchArgs[1]>["body"];

/** A recorded fetch call, for asserting how the backend addressed S3. */
interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: FetchBody;
}

/**
 * Build an S3Backend over a scripted `fetch` that answers from `responder` and
 * records every call. No network is ever touched.
 */
function makeBackend(
  responder: (call: Recorded) => Response,
  overrides: Partial<S3BackendOptions> = {},
): { backend: S3Backend; calls: Recorded[] } {
  const calls: Recorded[] = [];

  const fetchImpl = (async (input: FetchArgs[0], init?: FetchArgs[1]) => {
    const call: Recorded = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ?? undefined,
    };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;

  const backend = new S3Backend({
    endpoint: "https://s3.us-east-1.amazonaws.com/",
    bucket: "my-bucket",
    region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    fetch: fetchImpl,
    now: () => new Date("2013-05-24T00:00:00Z"),
    ...overrides,
  });

  return { backend, calls };
}

describe("S3Backend put/get/delete/exists/list", () => {
  it("PUTs bytes to the path-style object URL with a signed Authorization", async () => {
    const { backend, calls } = makeBackend(() => new Response(null, { status: 200 }));

    await backend.put("dir/file.txt", Buffer.from("hello"));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe("https://s3.us-east-1.amazonaws.com/my-bucket/dir/file.txt");
    expect(calls[0]!.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
    expect(new Uint8Array(calls[0]!.body as Uint8Array)).toEqual(
      new Uint8Array(Buffer.from("hello")),
    );
  });

  it("GETs and returns the object bytes as a Buffer", async () => {
    const { backend } = makeBackend(() => new Response(Buffer.from("payload")));

    const bytes = await backend.get("a.txt");

    expect(bytes).toBeInstanceOf(Buffer);
    expect(bytes.toString("utf8")).toBe("payload");
  });

  it("maps a 404 GET to STORAGE_NOT_FOUND", async () => {
    const { backend } = makeBackend(() => new Response("missing", { status: 404 }));

    await expect(backend.get("nope")).rejects.toMatchObject({ code: "STORAGE_NOT_FOUND" });
  });

  it("DELETEs a key", async () => {
    const { backend, calls } = makeBackend(() => new Response(null, { status: 204 }));

    await backend.delete("gone.txt");

    expect(calls[0]!.method).toBe("DELETE");
  });

  it("treats a 404 DELETE as a no-op", async () => {
    const { backend } = makeBackend(() => new Response(null, { status: 404 }));

    await expect(backend.delete("absent")).resolves.toBeUndefined();
  });

  it("reports existence true on 200 and false on 404 via HEAD", async () => {
    const present = makeBackend(() => new Response(null, { status: 200 }));
    const absent = makeBackend(() => new Response(null, { status: 404 }));

    expect(await present.backend.exists("here")).toBe(true);
    expect(present.calls[0]!.method).toBe("HEAD");
    expect(await absent.backend.exists("gone")).toBe(false);
  });

  it("lists keys from a ListObjectsV2 XML body, decoding entities", async () => {
    const xml =
      "<ListBucketResult><Contents><Key>img/a.png</Key></Contents>" +
      "<Contents><Key>a&amp;b/c&lt;d&gt;e&quot;f&apos;g</Key></Contents></ListBucketResult>";
    const { backend, calls } = makeBackend(() => new Response(xml, { status: 200 }));

    const keys = await backend.list("img/");

    expect(keys).toEqual(["img/a.png", `a&b/c<d>e"f'g`]);
    expect(calls[0]!.url).toContain("list-type=2");
    expect(calls[0]!.url).toContain("prefix=img%2F");
  });

  it("lists without a prefix when none is given", async () => {
    const { backend, calls } = makeBackend(
      () => new Response("<ListBucketResult></ListBucketResult>", { status: 200 }),
    );

    expect(await backend.list()).toEqual([]);
    expect(calls[0]!.url).not.toContain("prefix=");
  });
});

describe("S3Backend list() pagination", () => {
  it("follows the continuation token across pages and returns every key", async () => {
    // Page 1 is truncated and hands back an opaque base64 token (`/`, `+`, `=`);
    // page 2 closes the run with `IsTruncated>false` and no token.
    const page1 =
      "<ListBucketResult><IsTruncated>true</IsTruncated>" +
      "<NextContinuationToken>tok/N+xt=</NextContinuationToken>" +
      "<Contents><Key>a/1</Key></Contents>" +
      "<Contents><Key>a/2</Key></Contents></ListBucketResult>";
    const page2 =
      "<ListBucketResult><IsTruncated>false</IsTruncated>" +
      "<Contents><Key>a/3</Key></Contents></ListBucketResult>";

    const { backend, calls } = makeBackend((call) =>
      call.url.includes("continuation-token")
        ? new Response(page2, { status: 200 })
        : new Response(page1, { status: 200 }),
    );

    const keys = await backend.list("a/");

    // Every key across both pages — not just the first 1000-key page.
    expect(keys).toEqual(["a/1", "a/2", "a/3"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).not.toContain("continuation-token");
    // The token resumes page 2, strict-encoded (`/`→%2F, `+`→%2B, `=`→%3D) so it
    // matches the signature; the prefix rides along on every page.
    expect(calls[1]!.url).toContain("continuation-token=tok%2FN%2Bxt%3D");
    expect(calls[1]!.url).toContain("prefix=a%2F");
  });

  it("stops after one request when the first page is not truncated", async () => {
    const xml =
      "<ListBucketResult><IsTruncated>false</IsTruncated>" +
      "<Contents><Key>only.txt</Key></Contents></ListBucketResult>";
    const { backend, calls } = makeBackend(() => new Response(xml, { status: 200 }));

    expect(await backend.list()).toEqual(["only.txt"]);
    expect(calls).toHaveLength(1);
  });

  it("refuses a truncated page that omits the continuation token", async () => {
    // `IsTruncated>true` with no `NextContinuationToken` is malformed — dropping
    // the remaining pages would be silent data loss, so we fail loud instead.
    const xml =
      "<ListBucketResult><IsTruncated>true</IsTruncated>" +
      "<Contents><Key>a/1</Key></Contents></ListBucketResult>";
    const { backend } = makeBackend(() => new Response(xml, { status: 200 }));

    await expect(backend.list()).rejects.toMatchObject({
      code: "STORAGE_BACKEND_ERROR",
      details: { operation: "list", truncated: true },
    });
  });

  it("refuses a truncated page with an EMPTY continuation token instead of looping forever", async () => {
    // `IsTruncated>true` with an empty `<NextContinuationToken></…>` is malformed:
    // resuming from an empty token re-fetches page 1, an infinite loop. The guard
    // must treat empty like absent and fail loud (not spin).
    const xml =
      "<ListBucketResult><IsTruncated>true</IsTruncated>" +
      "<NextContinuationToken></NextContinuationToken>" +
      "<Contents><Key>a/1</Key></Contents></ListBucketResult>";
    const { backend, calls } = makeBackend(() => new Response(xml, { status: 200 }));

    await expect(backend.list()).rejects.toMatchObject({
      code: "STORAGE_BACKEND_ERROR",
      details: { operation: "list", truncated: true },
    });
    // It refused on the first page — it did NOT re-request in a loop.
    expect(calls).toHaveLength(1);
  });
});

describe("S3Backend error surfacing", () => {
  it("turns a non-2xx put into STORAGE_BACKEND_ERROR carrying the status", async () => {
    const { backend } = makeBackend(() => new Response("AccessDenied", { status: 403 }));

    try {
      await backend.put("k", Buffer.from("x"));
      expect.unreachable("a 403 should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).code).toBe("STORAGE_BACKEND_ERROR");
      expect((error as StorageError).details).toMatchObject({ status: 403, operation: "put" });
    }
  });

  it("surfaces a non-404 GET failure as STORAGE_BACKEND_ERROR", async () => {
    const { backend } = makeBackend(() => new Response("boom", { status: 500 }));

    await expect(backend.get("k")).rejects.toMatchObject({ code: "STORAGE_BACKEND_ERROR" });
  });

  it("surfaces a non-404 exists failure as STORAGE_BACKEND_ERROR", async () => {
    const { backend } = makeBackend(() => new Response("boom", { status: 500 }));

    await expect(backend.exists("k")).rejects.toMatchObject({ code: "STORAGE_BACKEND_ERROR" });
  });

  it("surfaces a non-404 delete failure as STORAGE_BACKEND_ERROR", async () => {
    const { backend } = makeBackend(() => new Response("boom", { status: 500 }));

    await expect(backend.delete("k")).rejects.toMatchObject({ code: "STORAGE_BACKEND_ERROR" });
  });

  it("surfaces a list failure as STORAGE_BACKEND_ERROR", async () => {
    const { backend } = makeBackend(() => new Response("boom", { status: 500 }));

    await expect(backend.list()).rejects.toMatchObject({ code: "STORAGE_BACKEND_ERROR" });
  });
});

describe("S3Backend traversal guard parity", () => {
  it("rejects a parent-traversal key", async () => {
    const { backend, calls } = makeBackend(() => new Response(null, { status: 200 }));

    await expect(backend.put("../escape", Buffer.from("x"))).rejects.toMatchObject({
      code: "STORAGE_INVALID_KEY",
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects a leading-slash key", async () => {
    const { backend } = makeBackend(() => new Response(null, { status: 200 }));

    await expect(backend.get("/etc/passwd")).rejects.toMatchObject({
      code: "STORAGE_INVALID_KEY",
    });
  });

  it("rejects a traversal key passed to url()", async () => {
    const { backend } = makeBackend(() => new Response(null, { status: 200 }));

    await expect(backend.url("../escape")).rejects.toMatchObject({ code: "STORAGE_INVALID_KEY" });
  });
});

describe("S3Backend url()", () => {
  it("presigns a time-limited URL when given an expiry", async () => {
    const { backend } = makeBackend(() => new Response(null, { status: 200 }));

    const url = await backend.url("avatars/me.png", { expiresInSeconds: 300 });
    const parsed = new URL(url);

    expect(parsed.pathname).toBe("/my-bucket/avatars/me.png");
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the public CDN URL when a publicBaseUrl is configured", async () => {
    const { backend } = makeBackend(() => new Response(null, { status: 200 }), {
      publicBaseUrl: "https://cdn.example.com/",
    });

    expect(await backend.url("img/a.png")).toBe("https://cdn.example.com/img/a.png");
  });

  it("falls back to the path-style object URL for a public url with no CDN", async () => {
    const { backend } = makeBackend(() => new Response(null, { status: 200 }));

    expect(await backend.url("img/a.png")).toBe(
      "https://s3.us-east-1.amazonaws.com/my-bucket/img/a.png",
    );
  });

  it("treats expiresInSeconds: 0 as a public (non-presigned) URL", async () => {
    const { backend } = makeBackend(() => new Response(null, { status: 200 }));

    const url = await backend.url("img/a.png", { expiresInSeconds: 0 });

    expect(url).not.toContain("X-Amz-Signature");
  });

  it("strict-encodes special chars in a public URL key", async () => {
    const { backend } = makeBackend(() => new Response(null, { status: 200 }), {
      publicBaseUrl: "https://cdn.example.com",
    });

    // A space and `(` must be percent-encoded; the slash stays a separator.
    expect(await backend.url("photos/ada (1).png")).toBe(
      "https://cdn.example.com/photos/ada%20%281%29.png",
    );
  });
});

describe("S3Backend wire encoding matches the signature (no SignatureDoesNotMatch)", () => {
  // The signer canonicalizes the path/query with strict RFC 3986; the request
  // must travel under the SAME encoding or S3 rejects it. encodeURIComponent
  // leaves `!*'()` literal and URLSearchParams serializes a space as `+`, so
  // these pin that the backend uses the strict encoder on the wire.
  it("strict-encodes `!*'()` and spaces in an object key", async () => {
    const { backend, calls } = makeBackend(() => new Response(null, { status: 200 }));

    await backend.put("photos/ada (1)!'.jpg", Buffer.from("x"));

    expect(calls[0]!.url).toBe(
      "https://s3.us-east-1.amazonaws.com/my-bucket/photos/ada%20%281%29%21%27.jpg",
    );
  });

  it("strict-encodes a list prefix (space→%20, *→%2A, ~ literal — never +)", async () => {
    const { backend, calls } = makeBackend(
      () => new Response("<ListBucketResult></ListBucketResult>", { status: 200 }),
    );

    await backend.list("a b*c~d");

    expect(calls[0]!.url).toContain("prefix=a%20b%2Ac~d");
    expect(calls[0]!.url).not.toContain("prefix=a+b");
  });
});

describe("Storage facade url()", () => {
  it("delegates url() to a backend that supports it", async () => {
    const { backend } = makeBackend(() => new Response(null, { status: 200 }), {
      publicBaseUrl: "https://cdn.example.com",
    });
    const storage = new Storage(backend);

    expect(await storage.url("k.png")).toBe("https://cdn.example.com/k.png");
  });

  it("throws STORAGE_URL_UNSUPPORTED for a backend without url()", async () => {
    const storage = new Storage({
      put: async () => {},
      get: async () => Buffer.alloc(0),
      delete: async () => {},
      exists: async () => false,
      list: async () => [],
    });

    await expect(storage.url("k")).rejects.toMatchObject({ code: "STORAGE_URL_UNSUPPORTED" });
  });
});

describe("S3Backend defaults", () => {
  it("uses a real clock when none is injected, signing with the wall-clock date", async () => {
    // No `now` override: presigning calls the default `() => new Date()` factory.
    // No `fetch` override either, exercising the `?? fetch` default — presigning
    // never touches the network, so global fetch is never actually invoked.
    const backend = new S3Backend({
      endpoint: "https://s3.amazonaws.com",
      bucket: "b",
      region: "us-east-1",
      accessKeyId: "id",
      secretAccessKey: "secret",
    });

    const url = await backend.url("k", { expiresInSeconds: 60 });

    expect(new URL(url).searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("falls back to the path-style object URL for a public url with no CDN", async () => {
    const backend = new S3Backend({
      endpoint: "https://s3.amazonaws.com",
      bucket: "b",
      region: "us-east-1",
      accessKeyId: "id",
      secretAccessKey: "secret",
    });

    expect(await backend.url("k")).toBe("https://s3.amazonaws.com/b/k");
  });
});

describe("S3Backend session token", () => {
  it("forwards the STS session token on signed requests", async () => {
    const { backend, calls } = makeBackend(() => new Response(null, { status: 200 }), {
      sessionToken: "STS-TOKEN",
    });

    await backend.put("k", Buffer.from("x"));

    expect(calls[0]!.headers["x-amz-security-token"]).toBe("STS-TOKEN");
  });

  it("includes the session token in a presigned url", async () => {
    const { backend } = makeBackend(() => new Response(null, { status: 200 }), {
      sessionToken: "STS-TOKEN",
    });

    const url = await backend.url("k", { expiresInSeconds: 60 });

    expect(new URL(url).searchParams.get("X-Amz-Security-Token")).toBe("STS-TOKEN");
  });
});
