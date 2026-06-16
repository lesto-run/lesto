import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeployError, remoteReleaseStore, rollback, shipRelease } from "../src/index";

import type { RemoteReleaseStoreOptions, StaticTarget } from "../src/index";

type FetchArgs = Parameters<typeof fetch>;
type FetchBody = NonNullable<FetchArgs[1]>["body"];

/** A recorded fetch call, for asserting how the store addressed the object store. */
interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: FetchBody;
}

/**
 * Build a {@link remoteReleaseStore} over a scripted `fetch` that answers from
 * `responder` and records every call. No network is ever touched — this is the
 * R2-shaped fake the acceptance criteria call for.
 */
function makeStore(
  responder: (call: Recorded) => Response,
  overrides: Partial<RemoteReleaseStoreOptions> = {},
): { store: ReturnType<typeof remoteReleaseStore>; calls: Recorded[] } {
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

  const store = remoteReleaseStore({
    endpoint: "https://acct.r2.cloudflarestorage.com",
    bucket: "site",
    region: "auto",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    fetch: fetchImpl,
    now: () => new Date("2013-05-24T00:00:00Z"),
    // A built-output read that does not touch disk, so the loop stays pure.
    read: (_outRoot, file) => Promise.resolve(new TextEncoder().encode(`bytes of ${file}`)),
    ...overrides,
  });

  return { store, calls };
}

/** An empty ListObjectsV2 body — the store has no releases yet. */
const EMPTY_LIST = "<ListBucketResult></ListBucketResult>";

/** A one-file static target, enough to watch the staging prefix and the flip order. */
const releaseTarget: StaticTarget = {
  kind: "static",
  site: "marketing",
  basePath: "/",
  routing: { basePath: "/", mode: "static" },
  files: [{ file: "marketing/index.html", route: "/", contentType: "text/html; charset=utf-8" }],
};

describe("remoteReleaseStore put", () => {
  it("PUTs staged bytes to the path-style object URL with a signed Authorization", async () => {
    const { store, calls } = makeStore(() => new Response(null, { status: 200 }));

    await store.put("releases/v1/marketing/index.html", new Uint8Array([1, 2, 3]), "text/html");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(
      "https://acct.r2.cloudflarestorage.com/site/releases/v1/marketing/index.html",
    );
    expect(calls[0]!.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
    expect(new Uint8Array(calls[0]!.body as Uint8Array)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("UTF-8-encodes a string body (the convenience arm)", async () => {
    const { store, calls } = makeStore(() => new Response(null, { status: 200 }));

    await store.put("releases/v1/page.html", "<h1>hi</h1>", "text/html");

    expect(new TextDecoder().decode(calls[0]!.body as Uint8Array)).toBe("<h1>hi</h1>");
  });

  it("strict-encodes a key so the wire URL matches the signature", async () => {
    const { store, calls } = makeStore(() => new Response(null, { status: 200 }));

    // A space and `(` must be percent-encoded; slashes stay separators.
    await store.put("releases/v1/photo (1).jpg", new Uint8Array(), "image/jpeg");

    expect(calls[0]!.url).toBe(
      "https://acct.r2.cloudflarestorage.com/site/releases/v1/photo%20%281%29.jpg",
    );
  });

  it("surfaces a non-2xx PUT as DEPLOY_REMOTE_ERROR carrying the status", async () => {
    const { store } = makeStore(() => new Response("AccessDenied", { status: 403 }));

    try {
      await store.put("releases/v1/x", new Uint8Array(), "text/plain");
      expect.unreachable("a 403 PUT should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DeployError);
      expect((error as DeployError).code).toBe("DEPLOY_REMOTE_ERROR");
      expect((error as DeployError).details).toMatchObject({ status: 403, operation: "put" });
    }
  });
});

describe("remoteReleaseStore setCurrent (the atomic flip)", () => {
  it("PUTs the new live version to the pointer object", async () => {
    const { store, calls } = makeStore(() => new Response(null, { status: 200 }));

    await store.setCurrent("v2");

    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe("https://acct.r2.cloudflarestorage.com/site/current");
    expect(new TextDecoder().decode(calls[0]!.body as Uint8Array)).toBe("v2");
  });

  it("writes a custom pointer key when configured (one bucket, many sites)", async () => {
    const { store, calls } = makeStore(() => new Response(null, { status: 200 }), {
      pointerKey: "sites/marketing/current",
    });

    await store.setCurrent("v1");

    expect(calls[0]!.url).toBe(
      "https://acct.r2.cloudflarestorage.com/site/sites/marketing/current",
    );
  });

  it("surfaces a failed pointer write as DEPLOY_REMOTE_ERROR", async () => {
    const { store } = makeStore(() => new Response("boom", { status: 500 }));

    await expect(store.setCurrent("v1")).rejects.toMatchObject({
      code: "DEPLOY_REMOTE_ERROR",
    });
  });
});

describe("remoteReleaseStore getCurrent", () => {
  it("returns the trimmed live version from the pointer object", async () => {
    const { store, calls } = makeStore(() => new Response("v3\n", { status: 200 }));

    expect(await store.getCurrent()).toBe("v3");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://acct.r2.cloudflarestorage.com/site/current");
  });

  it("is undefined before the first release (no pointer object yet)", async () => {
    const { store } = makeStore(() => new Response("missing", { status: 404 }));

    expect(await store.getCurrent()).toBeUndefined();
  });

  it("surfaces a non-404 pointer read failure as DEPLOY_REMOTE_ERROR", async () => {
    const { store } = makeStore(() => new Response("boom", { status: 500 }));

    await expect(store.getCurrent()).rejects.toMatchObject({ code: "DEPLOY_REMOTE_ERROR" });
  });
});

describe("remoteReleaseStore listReleases", () => {
  it("lists version directories from CommonPrefixes, decoding entities", async () => {
    // A real ListObjectsV2 response echoes the request prefix in a top-level
    // <Prefix> (skipped), then one CommonPrefixes per version. One version name
    // carries an XML entity to exercise the decoder; one unrelated long prefix
    // exercises the startsWith guard's false arm.
    const xml =
      "<ListBucketResult>" +
      "<Prefix>releases/</Prefix>" +
      "<CommonPrefixes><Prefix>releases/v1/</Prefix></CommonPrefixes>" +
      "<CommonPrefixes><Prefix>releases/a&amp;b/</Prefix></CommonPrefixes>" +
      "<CommonPrefixes><Prefix>archive/old/</Prefix></CommonPrefixes>" +
      "</ListBucketResult>";

    const { store, calls } = makeStore(() => new Response(xml, { status: 200 }));

    expect(await store.listReleases()).toEqual(["v1", "a&b"]);
    expect(calls[0]!.url).toContain("list-type=2");
    expect(calls[0]!.url).toContain("delimiter=%2F");
    expect(calls[0]!.url).toContain("prefix=releases%2F");
  });

  it("returns an empty list when nothing is published", async () => {
    const { store } = makeStore(() => new Response(EMPTY_LIST, { status: 200 }));

    expect(await store.listReleases()).toEqual([]);
  });

  it("surfaces a list failure as DEPLOY_REMOTE_ERROR", async () => {
    const { store } = makeStore(() => new Response("boom", { status: 500 }));

    await expect(store.listReleases()).rejects.toMatchObject({ code: "DEPLOY_REMOTE_ERROR" });
  });
});

describe("remoteReleaseStore options", () => {
  it("normalizes a trailing slash on the endpoint", async () => {
    const { store, calls } = makeStore(() => new Response(null, { status: 200 }), {
      endpoint: "https://acct.r2.cloudflarestorage.com/",
    });

    await store.put("releases/v1/x", new Uint8Array(), "text/plain");

    expect(calls[0]!.url).toBe("https://acct.r2.cloudflarestorage.com/site/releases/v1/x");
  });

  it("signs and forwards an STS session token when supplied", async () => {
    const { store, calls } = makeStore(() => new Response(null, { status: 200 }), {
      sessionToken: "STS-TOKEN",
    });

    await store.setCurrent("v1");

    expect(calls[0]!.headers["x-amz-security-token"]).toBe("STS-TOKEN");
  });

  it("uses the global fetch and a wall-clock now when neither is injected", async () => {
    // No `fetch`/`now`/`read` overrides: exercise the `?? fetch` and
    // `?? () => new Date()` defaults. We stub the global fetch so no network is
    // touched, then assert the request still went out signed.
    const seen: string[] = [];
    const stub = vi.fn(async (input: FetchArgs[0]) => {
      seen.push(String(input));
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", stub);

    try {
      const store = remoteReleaseStore({
        endpoint: "https://acct.r2.cloudflarestorage.com",
        bucket: "site",
        region: "auto",
        accessKeyId: "id",
        secretAccessKey: "secret",
      });

      await store.setCurrent("v1");

      expect(seen).toEqual(["https://acct.r2.cloudflarestorage.com/site/current"]);
      expect(stub).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// Full release journey against the R2-shaped fake: stage → gate → flip, then
// rollback. This is the acceptance leg — the carefully-ordered release
// machinery, reachable on the headline target.
// ---------------------------------------------------------------------------

/**
 * An in-process R2 fake: a `Map` of objects keyed by their path, answering
 * PUT/GET/list the way the store expects. This is the recorded-fixture "live
 * smoke" — a real release+rollback round-trip with no network.
 */
function r2Fake(): {
  store: ReturnType<typeof remoteReleaseStore>;
  objects: Map<string, Uint8Array>;
} {
  const objects = new Map<string, Uint8Array>();

  const fetchImpl = (async (input: FetchArgs[0], init?: FetchArgs[1]) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = decodeURIComponent(url.pathname.replace("/site/", "").replace(/^\//, ""));

    if (method === "PUT") {
      objects.set(path, new Uint8Array(init!.body as Uint8Array));
      return new Response(null, { status: 200 });
    }

    // A list request: enumerate version directories under releases/ as
    // CommonPrefixes, the way ListObjectsV2 with a delimiter would.
    if (url.search.includes("list-type=2")) {
      const versions = new Set<string>();
      for (const key of objects.keys()) {
        const match = /^releases\/([^/]+)\//.exec(key);
        if (match) versions.add(match[1]!);
      }
      const body =
        "<ListBucketResult><Prefix>releases/</Prefix>" +
        [...versions]
          .map((v) => `<CommonPrefixes><Prefix>releases/${v}/</Prefix></CommonPrefixes>`)
          .join("") +
        "</ListBucketResult>";
      return new Response(body, { status: 200 });
    }

    // A GET of the pointer (or any object): 404 when absent.
    const bytes = objects.get(path);
    return bytes === undefined
      ? new Response(null, { status: 404 })
      : new Response(bytes, { status: 200 });
  }) as typeof fetch;

  const store = remoteReleaseStore({
    endpoint: "https://acct.r2.cloudflarestorage.com",
    bucket: "site",
    region: "auto",
    accessKeyId: "id",
    secretAccessKey: "secret",
    fetch: fetchImpl,
    now: () => new Date("2013-05-24T00:00:00Z"),
    read: (_outRoot, file) => Promise.resolve(new TextEncoder().encode(`bytes of ${file}`)),
  });

  return { store, objects };
}

describe("remoteReleaseStore release journey (R2 fake)", () => {
  it("stages every file under the release prefix, then flips the pointer", async () => {
    const { store, objects } = r2Fake();

    const release = await shipRelease(releaseTarget, "out", store, { version: "v1" });

    // Staged immutably, then the pointer flipped to it.
    expect(objects.has("releases/v1/marketing/index.html")).toBe(true);
    expect(new TextDecoder().decode(objects.get("current")!)).toBe("v1");
    expect(release).toEqual({ version: "v1", site: "marketing", routes: ["/"] });
  });

  it("records the replaced version and rolls back to it", async () => {
    const { store, objects } = r2Fake();

    await shipRelease(releaseTarget, "out", store, { version: "v1" });
    const second = await shipRelease(releaseTarget, "out", store, { version: "v2" });

    expect(second.previous).toBe("v1");
    expect(new TextDecoder().decode(objects.get("current")!)).toBe("v2");

    const result = await rollback(store, "v1");

    expect(result).toEqual({ from: "v2", to: "v1" });
    expect(new TextDecoder().decode(objects.get("current")!)).toBe("v1");
  });

  it("refuses to flip when the health gate fails — staged files stay, pointer stays", async () => {
    const { store, objects } = r2Fake();

    await shipRelease(releaseTarget, "out", store, { version: "v1" });

    await expect(
      shipRelease(releaseTarget, "out", store, {
        version: "v2",
        verify: () => Promise.resolve(false),
      }),
    ).rejects.toMatchObject({ code: "DEPLOY_RELEASE_UNHEALTHY" });

    // v2's files are staged for inspection, but the live pointer never moved off v1.
    expect(objects.has("releases/v2/marketing/index.html")).toBe(true);
    expect(new TextDecoder().decode(objects.get("current")!)).toBe("v1");
  });

  it("refuses a rollback to a version that was never published", async () => {
    const { store } = r2Fake();

    await shipRelease(releaseTarget, "out", store, { version: "v1" });

    await expect(rollback(store, "ghost")).rejects.toMatchObject({
      code: "DEPLOY_UNKNOWN_RELEASE",
    });
  });
});

describe("remoteReleaseStore default disk read", () => {
  let outRoot: string;

  beforeEach(async () => {
    outRoot = await mkdtemp(join(tmpdir(), "keel-remote-out-"));
    await writeFile(join(outRoot, "index.html"), "<h1>disk</h1>", "utf8");
  });

  afterEach(async () => {
    await rm(outRoot, { recursive: true, force: true });
  });

  it("reads built bytes off the local build output when no read is injected", async () => {
    // No `read` override: exercise the default `node:fs` build-output read. The
    // R2 side is still a fake, so nothing hits the network.
    const objects = new Map<string, Uint8Array>();

    const fetchImpl = (async (input: FetchArgs[0], init?: FetchArgs[1]) => {
      const url = new URL(String(input));
      const path = decodeURIComponent(url.pathname.replace("/site/", "").replace(/^\//, ""));
      if ((init?.method ?? "GET") === "PUT") {
        objects.set(path, new Uint8Array(init!.body as Uint8Array));
        return new Response(null, { status: 200 });
      }
      const bytes = objects.get(path);
      return bytes === undefined
        ? new Response(null, { status: 404 })
        : new Response(bytes, { status: 200 });
    }) as typeof fetch;

    const store = remoteReleaseStore({
      endpoint: "https://acct.r2.cloudflarestorage.com",
      bucket: "site",
      region: "auto",
      accessKeyId: "id",
      secretAccessKey: "secret",
      fetch: fetchImpl,
      now: () => new Date("2013-05-24T00:00:00Z"),
    });

    const target: StaticTarget = {
      ...releaseTarget,
      files: [{ file: "index.html", route: "/", contentType: "text/html; charset=utf-8" }],
    };

    await shipRelease(target, outRoot, store, { version: "v1" });

    expect(new TextDecoder().decode(objects.get("releases/v1/index.html")!)).toBe("<h1>disk</h1>");
    expect(new TextDecoder().decode(objects.get("current")!)).toBe("v1");
  });
});
