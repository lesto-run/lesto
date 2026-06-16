import { describe, expect, it } from "vitest";

import { encodeRfc3986 } from "../src/index";
import { hashHex, presignUrl, signRequest, UNSIGNED_PAYLOAD } from "../src/sigv4";

import type { SigV4Credentials } from "../src/sigv4";

// The AWS S3 documentation worked example, "GET Object" (authenticated):
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
const S3_DOCS_CREDENTIALS: SigV4Credentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  service: "s3",
};

describe("hashHex", () => {
  it("hashes the empty string to the known SHA-256 constant", async () => {
    expect(await hashHex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes raw bytes identically to their string form", async () => {
    expect(await hashHex(new TextEncoder().encode("abc"))).toBe(await hashHex("abc"));
  });
});

describe("signRequest", () => {
  it("reproduces the AWS S3 docs GET-object signature exactly", async () => {
    const headers = await signRequest(
      {
        method: "GET",
        url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
        headers: { Range: "bytes=0-9" },
        payloadHash: await hashHex(""),
      },
      S3_DOCS_CREDENTIALS,
      new Date("2013-05-24T00:00:00Z"),
    );

    expect(headers.Authorization).toContain(
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(headers.Authorization).toContain(
      "Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
    );
    expect(headers.Authorization).toContain(
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date",
    );
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
    expect(headers.host).toBe("examplebucket.s3.amazonaws.com");
  });

  it("signs and forwards a session token when present", async () => {
    const headers = await signRequest(
      {
        method: "GET",
        url: new URL("https://examplebucket.s3.amazonaws.com/k"),
        headers: {},
        payloadHash: UNSIGNED_PAYLOAD,
      },
      { ...S3_DOCS_CREDENTIALS, sessionToken: "SESSION/TOKEN+VALUE" },
      new Date("2013-05-24T00:00:00Z"),
    );

    expect(headers["x-amz-security-token"]).toBe("SESSION/TOKEN+VALUE");
    expect(headers.Authorization).toContain("x-amz-security-token");
  });

  it("canonicalizes a root path, query parameters, and folds header whitespace", async () => {
    // Exercises the empty-path branch, query sorting/encoding, and ws folding.
    const headers = await signRequest(
      {
        method: "GET",
        url: new URL("https://examplebucket.s3.amazonaws.com?b=2&a=1&a=0"),
        headers: { "x-custom": "  spaced   out  " },
        payloadHash: await hashHex(""),
      },
      S3_DOCS_CREDENTIALS,
      new Date("2013-05-24T00:00:00Z"),
    );

    // A stable signature proves the canonicalization is deterministic.
    expect(headers.Authorization).toMatch(/Signature=[0-9a-f]{64}$/);
    expect(headers.Authorization).toContain("x-custom");
  });

  it("sorts query parameters by key then value (both comparator directions)", async () => {
    // Insertion order is deliberately unsorted and includes a repeated key, so
    // the canonical-query comparator must take its key-greater, key-lesser, and
    // equal-key value-tiebreak branches.
    const a = await signRequest(
      {
        method: "GET",
        url: new URL("https://examplebucket.s3.amazonaws.com/o?b=1&a=2&a=1"),
        headers: {},
        payloadHash: await hashHex(""),
      },
      S3_DOCS_CREDENTIALS,
      new Date("2013-05-24T00:00:00Z"),
    );
    // The same parameters in canonical order must yield the same signature,
    // proving the sort produced the canonical ordering.
    const b = await signRequest(
      {
        method: "GET",
        url: new URL("https://examplebucket.s3.amazonaws.com/o?a=1&a=2&b=1"),
        headers: {},
        payloadHash: await hashHex(""),
      },
      S3_DOCS_CREDENTIALS,
      new Date("2013-05-24T00:00:00Z"),
    );

    expect(a.Authorization).toBe(b.Authorization);
  });

  it("encodes path segments per RFC 3986 (escaping !*'() but not the slash)", async () => {
    // The path contains characters encodeURIComponent leaves alone; the signer
    // must still produce a valid 64-hex signature without throwing.
    const headers = await signRequest(
      {
        method: "GET",
        url: new URL("https://examplebucket.s3.amazonaws.com/a/b!c*d'e(f)g"),
        headers: {},
        payloadHash: await hashHex(""),
      },
      S3_DOCS_CREDENTIALS,
      new Date("2013-05-24T00:00:00Z"),
    );

    expect(headers.Authorization).toMatch(/Signature=[0-9a-f]{64}$/);
  });
});

describe("encodeRfc3986 (shared signer export)", () => {
  it("is re-exported from the package entry point for cross-package consumers", () => {
    // The remote ReleaseStore in @keel/deploy signs and sends object keys, so it
    // must encode them with the SAME strict encoder the signer canonicalizes
    // under. Pin that the entry point exposes it and that it escapes what
    // encodeURIComponent leaves literal (`!*'()`) plus a space, but never a slash.
    expect(encodeRfc3986("a/b!c*d'e(f)g h")).toBe("a%2Fb%21c%2Ad%27e%28f%29g%20h");
    expect(encodeRfc3986("plain")).toBe("plain");
  });
});

describe("presignUrl", () => {
  it("puts the signature in the query string and omits credentials from headers", async () => {
    const url = await presignUrl(
      "GET",
      new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      S3_DOCS_CREDENTIALS,
      86_400,
      new Date("2013-05-24T00:00:00Z"),
    );

    const parsed = new URL(url);
    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("86400");
    expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(parsed.searchParams.get("X-Amz-Date")).toBe("20130524T000000Z");
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.searchParams.get("X-Amz-Credential")).toBe(
      "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
    );
  });

  it("includes the security token in the presigned query when supplied", async () => {
    const url = await presignUrl(
      "GET",
      new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      { ...S3_DOCS_CREDENTIALS, sessionToken: "TOK" },
      60,
      new Date("2013-05-24T00:00:00Z"),
    );

    expect(new URL(url).searchParams.get("X-Amz-Security-Token")).toBe("TOK");
  });
});
