import { describe, expect, it } from "vitest";

import { applyResponse } from "../src/index";

import type { WritableResponse } from "../src/index";

describe("applyResponse", () => {
  it("writes the status and headers, then ends with the body", () => {
    const calls: Array<
      | { kind: "writeHead"; status: number; headers: Record<string, string> }
      | { kind: "end"; body: string }
    > = [];

    const res: WritableResponse = {
      writeHead: (status, headers) => calls.push({ kind: "writeHead", status, headers }),
      end: (body) => calls.push({ kind: "end", body }),
    };

    applyResponse(res, {
      status: 201,
      headers: { "content-type": "application/json" },
      body: '{"id":1}',
    });

    expect(calls).toEqual([
      { kind: "writeHead", status: 201, headers: { "content-type": "application/json" } },
      { kind: "end", body: '{"id":1}' },
    ]);
  });
});
