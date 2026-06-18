import { describe, expect, it, vi } from "vitest";

import { createFetchProviderTransport, FetchProviderError } from "../src/index";

import type { ProviderRequestBody, RenderedEmail } from "../src/index";

const base = (): RenderedEmail => ({
  to: "ada@example.com",
  subject: "Hello",
  html: "<p>Hi</p>",
  from: "hi@app.com",
  messageId: "volo-mail-9",
});

const okResponse = (): Response => new Response(JSON.stringify({ id: "abc" }), { status: 200 });

type FetchArgs = [url: string, init: RequestInit];

/** A fetch mock whose recorded calls are typed `[url, init]`. */
function fetchMockReturning(impl: (...args: FetchArgs) => Promise<unknown>): typeof fetch {
  return vi.fn(impl) as unknown as typeof fetch;
}

/** Read the `[url, init]` of a recorded call off a mock fetch. */
function callOf(mock: typeof fetch, index = 0): FetchArgs {
  return (mock as unknown as { mock: { calls: FetchArgs[] } }).mock.calls[index]!;
}

describe("createFetchProviderTransport", () => {
  it("POSTs the default JSON body with bearer auth and an idempotency key", async () => {
    const fetchMock = fetchMockReturning(async () => okResponse());
    const transport = createFetchProviderTransport({
      endpoint: "https://api.test/emails",
      apiKey: "key_123",
      fetch: fetchMock,
    });

    await transport.send({ ...base(), text: "Hi", headers: { "List-Unsubscribe": "<u>" } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = callOf(fetchMock);
    expect(url).toBe("https://api.test/emails");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer key_123");
    expect(headers["idempotency-key"]).toBe("volo-mail-9");
    const body = JSON.parse(init.body as string) as ProviderRequestBody;
    expect(body).toMatchObject({
      from: "hi@app.com",
      to: "ada@example.com",
      subject: "Hello",
      html: "<p>Hi</p>",
      text: "Hi",
      messageId: "volo-mail-9",
      headers: { "List-Unsubscribe": "<u>" },
    });
  });

  it("uses defaultFrom when the email omits from", async () => {
    const fetchMock = fetchMockReturning(async () => okResponse());
    const transport = createFetchProviderTransport({
      endpoint: "https://api.test/emails",
      apiKey: "k",
      defaultFrom: "default@app.com",
      fetch: fetchMock,
    });

    const { from: _omit, ...noFrom } = base();
    await transport.send(noFrom as RenderedEmail);

    const body = JSON.parse(callOf(fetchMock)[1].body as string) as ProviderRequestBody;
    expect(body.from).toBe("default@app.com");
  });

  it("rejects (coded) when no from is available", async () => {
    const transport = createFetchProviderTransport({
      endpoint: "https://api.test/emails",
      apiKey: "k",
      fetch: vi.fn() as unknown as typeof fetch,
    });

    const { from: _omit, ...noFrom } = base();
    await expect(transport.send(noFrom as RenderedEmail)).rejects.toMatchObject({
      code: "MAIL_TRANSPORT_PROVIDER_REJECTED",
    });
  });

  it("applies a mapRequest hook to reshape the body", async () => {
    const fetchMock = fetchMockReturning(async () => okResponse());
    const transport = createFetchProviderTransport({
      endpoint: "https://api.test/v2/email",
      apiKey: "k",
      mapRequest: (b) => ({ Source: b.from, Destination: { ToAddresses: [b.to] } }),
      fetch: fetchMock,
    });

    await transport.send(base());
    const body = JSON.parse(callOf(fetchMock)[1].body as string);
    expect(body).toEqual({
      Source: "hi@app.com",
      Destination: { ToAddresses: ["ada@example.com"] },
    });
  });

  it("defaults to the global fetch when none is injected", async () => {
    const original = globalThis.fetch;
    const spy = vi.fn(async () => okResponse());
    globalThis.fetch = spy as unknown as typeof fetch;

    try {
      const transport = createFetchProviderTransport({
        endpoint: "https://api.test/emails",
        apiKey: "k",
      });
      await transport.send(base());
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("raises a coded rejected error on a non-2xx response, including the body", async () => {
    const fetchMock = vi.fn(async () => new Response("rate limited", { status: 429 }));
    const transport = createFetchProviderTransport({
      endpoint: "https://api.test/emails",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(transport.send(base())).rejects.toMatchObject({
      code: "MAIL_TRANSPORT_PROVIDER_REJECTED",
      details: { status: 429, body: "rate limited" },
    });
  });

  it("tolerates a response whose body cannot be read", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      async text(): Promise<string> {
        throw new Error("stream broken");
      },
    }));
    const transport = createFetchProviderTransport({
      endpoint: "https://api.test/emails",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(transport.send(base())).rejects.toMatchObject({
      code: "MAIL_TRANSPORT_PROVIDER_REJECTED",
      details: { status: 500, body: "" },
    });
  });

  it("raises a coded unreachable error when fetch throws", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("dns fail");
    });
    const transport = createFetchProviderTransport({
      endpoint: "https://api.test/emails",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(transport.send(base())).rejects.toMatchObject({
      code: "MAIL_TRANSPORT_PROVIDER_UNREACHABLE",
    });
  });

  it("stringifies a non-Error thrown by fetch in the unreachable detail", async () => {
    const fetchMock = vi.fn(async () => {
      throw "boom-string";
    });
    const transport = createFetchProviderTransport({
      endpoint: "https://api.test/emails",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(transport.send(base())).rejects.toMatchObject({
      code: "MAIL_TRANSPORT_PROVIDER_UNREACHABLE",
      details: { cause: "boom-string" },
    });
  });

  it("re-validates header injection at the transport edge", async () => {
    const transport = createFetchProviderTransport({
      endpoint: "https://api.test/emails",
      apiKey: "k",
      fetch: vi.fn(async () => okResponse()) as unknown as typeof fetch,
    });

    await expect(
      transport.send({ ...base(), to: "a@x.com\r\nBcc: e@x.com" }),
    ).rejects.toMatchObject({ code: "MAIL_INVALID_ADDRESS" });

    await expect(transport.send({ ...base(), subject: "S\nX: 1" })).rejects.toMatchObject({
      code: "MAIL_INVALID_HEADER",
    });

    await expect(transport.send({ ...base(), from: "f@x.com\r\nE: 1" })).rejects.toMatchObject({
      code: "MAIL_INVALID_ADDRESS",
    });

    await expect(transport.send({ ...base(), headers: { X: "v\r\nY: 1" } })).rejects.toMatchObject({
      code: "MAIL_INVALID_HEADER",
    });
  });
});

describe("FetchProviderError", () => {
  it("is coded and frozen", () => {
    const error = new FetchProviderError("MAIL_TRANSPORT_PROVIDER_REJECTED", "boom", { a: 1 });
    expect(error.code).toBe("MAIL_TRANSPORT_PROVIDER_REJECTED");
    expect(error.name).toBe("FetchProviderError");
    expect(Object.isFrozen(error.details)).toBe(true);
  });
});
