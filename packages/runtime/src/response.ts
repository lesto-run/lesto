import type { KeelResponse } from "@keel/web";

/**
 * The slice of a node:http `ServerResponse` we write through.
 *
 * Depending on this minimal shape — not on the concrete `ServerResponse` —
 * keeps {@link applyResponse} pure and unit-testable with a fake.
 */
export interface WritableResponse {
  writeHead(status: number, headers: Record<string, string>): void;

  end(body: string): void;
}

/** Write a {@link KeelResponse} onto the socket: status line, headers, then body. */
export function applyResponse(res: WritableResponse, response: KeelResponse): void {
  res.writeHead(response.status, response.headers);

  res.end(response.body);
}
