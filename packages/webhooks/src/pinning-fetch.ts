import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

import {
  isPrivateAddress,
  systemResolver,
  WebhookError,
  type FetchLike,
  type Resolver,
  type WebhookResponse,
} from "./webhooks";

/**
 * An IP-pinning {@link FetchLike} that closes the DNS-rebinding TOCTOU the default
 * delivery path documents as a residual.
 *
 * The hole: the SSRF guard resolves the host, then the fetch resolves it AGAIN, so
 * a hostile DNS server can answer "public" to the guard and "private" to the
 * connect in the gap between. This fetch removes the gap. It performs ONE
 * resolution, inside the socket's own connect-time `lookup`, validates every
 * returned address with the same {@link isPrivateAddress} rule the guard uses, and
 * hands the socket only that validated set. There is no second, unvalidated
 * resolution for an attacker to rebind, and — because only the connect address is
 * pinned, not the SNI/Host — TLS still verifies the certificate against the
 * original hostname.
 *
 * Node-only (it uses `node:http`/`node:https`); the default delivery `fetch` stays
 * the portable global `fetch` so the Workers edge build is unaffected. Opt in:
 *
 *   new Webhooks({ queue, secrets, fetch: nodePinningFetch() });
 */

/** A response, narrowed to what the deliverer needs — `node:http`'s `IncomingMessage` satisfies it. */
export interface PinnedResponse {
  readonly statusCode?: number | undefined;
  resume(): void;
  on(event: "end", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

/** A request handle, narrowed to what the deliverer drives — `node:http`'s `ClientRequest` satisfies it. */
export interface PinnedClientRequest {
  on(event: "error", listener: (error: Error) => void): this;
  write(chunk: string): void;
  end(): void;
}

/**
 * Issues the HTTP(S) request. Injected ONLY so tests need no socket; the default
 * ({@link nodeRequester}) dispatches to `node:http`/`node:https` by scheme. The
 * `lookup` it receives is the pinning resolver — node's socket calls it to map the
 * host to an address, so passing it here is what pins the connection.
 */
export type HttpRequester = (
  url: string,
  options: {
    method: string;
    headers: Record<string, string>;
    lookup: LookupFunction;
    /**
     * The delivery deadline, forwarded straight to `node:http`/`node:https` — an
     * abort destroys the socket, so a stalled receiver can't pin the worker. May
     * be `undefined` (a caller that set no deadline); node treats that as "no
     * signal", so it forwards straight through with no branch.
     */
    signal?: AbortSignal | undefined;
  },
  onResponse: (response: PinnedResponse) => void,
) => PinnedClientRequest;

/** Options for {@link nodePinningFetch}. */
export interface NodePinningFetchOptions {
  /**
   * Hostname -> IPs. Defaults to {@link systemResolver} — the SAME default the URL
   * guard uses, so the pin validates against the identical view of DNS.
   */
  readonly resolver?: Resolver;

  /** The HTTP(S) requester. Injected for tests; defaults to {@link nodeRequester}. */
  readonly requester?: HttpRequester;
}

/** A `WEBHOOK_URL_BLOCKED` for a connect we refuse — same code the guard raises. */
function blockedError(reason: string): WebhookError {
  return new WebhookError("WEBHOOK_URL_BLOCKED", `Refusing to connect: ${reason}`, {});
}

/**
 * Resolve a host and refuse the WHOLE set unless EVERY address is public — the
 * fail-closed policy that defeats a name resolving to both public and private.
 */
async function resolveValidatedAddresses(
  hostname: string,
  resolver: Resolver,
): Promise<readonly string[]> {
  const addresses = await resolver(hostname);

  if (addresses.length === 0) {
    throw blockedError(`host ${hostname} did not resolve.`);
  }

  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw blockedError(`host ${hostname} resolves to a private/reserved address (${address}).`);
    }
  }

  return addresses;
}

/**
 * Build the connect-time `lookup` that pins a validated address set.
 *
 * Honors node's `all` (Happy-Eyeballs asks for every address) and `family` (an
 * IPv4- or IPv6-only request) so the real socket gets what it expects — every
 * address it could connect to has already passed the public-only check.
 */
export function pinnedLookup(resolver: Resolver): LookupFunction {
  return (hostname, options, callback) => {
    void (async () => {
      try {
        const addresses = await resolveValidatedAddresses(hostname, resolver);

        const family = typeof options.family === "number" ? options.family : 0;

        const matching =
          family === 0 ? addresses : addresses.filter((address) => isIP(address) === family);

        if (matching.length === 0) {
          callback(
            blockedError(`host ${hostname} has no public address for family ${family}.`),
            "",
            0,
          );
          return;
        }

        if (options.all === true) {
          callback(
            null,
            matching.map((address) => ({ address, family: isIP(address) })),
          );
          return;
        }

        // `matching.length > 0` is guaranteed by the guard above; the cast only
        // narrows away the index-access `| undefined` that check already rules out.
        const pinned = matching[0] as string;

        callback(null, pinned, isIP(pinned));
      } catch (error) {
        // A blocked/failed resolution fails the connect — the socket never opens.
        callback(error instanceof Error ? error : blockedError(String(error)), "", 0);
      }
    })();
  };
}

/** The default requester: dispatch to `node:http` / `node:https` by URL scheme. */
const nodeRequester: HttpRequester = (url, options, onResponse) => {
  const send = new URL(url).protocol === "https:" ? httpsRequest : httpRequest;

  return send(url, options, (response) => onResponse(response));
};

/**
 * An IP-pinning {@link FetchLike} (see the module doc). The default `requester`
 * uses `node:http`/`node:https`, which never auto-follow redirects, so a 3xx
 * arrives as a 3xx response — the `redirect: "manual"` the deliverer asks for is
 * the inherent behavior, and `deliver` treats that non-2xx as a failed attempt.
 */
export function nodePinningFetch(options: NodePinningFetchOptions = {}): FetchLike {
  const resolver = options.resolver ?? systemResolver;
  const requester = options.requester ?? nodeRequester;
  const lookup = pinnedLookup(resolver);

  return (url, init) =>
    new Promise<WebhookResponse>((resolve, reject) => {
      let protocol: string;

      try {
        protocol = new URL(url).protocol;
      } catch {
        reject(
          new WebhookError("WEBHOOK_URL_BLOCKED", `webhook URL is not parseable: ${url}`, { url }),
        );
        return;
      }

      if (protocol !== "http:" && protocol !== "https:") {
        reject(
          new WebhookError(
            "WEBHOOK_URL_BLOCKED",
            `scheme "${protocol}" is not allowed (http/https only).`,
            { url },
          ),
        );
        return;
      }

      const request = requester(
        url,
        { method: init.method, headers: init.headers, lookup, signal: init.signal },
        (response) => {
          response.resume();
          response.on("error", reject);
          response.on("end", () => {
            const status = response.statusCode ?? 0;

            resolve({ ok: status >= 200 && status < 300, status });
          });
        },
      );

      request.on("error", reject);
      request.write(init.body);
      request.end();
    });
}
