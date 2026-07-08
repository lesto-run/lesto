import { describe, expect, it } from "vitest";

import { mintChannelToken, verifyChannelToken } from "../src/channel-token";
import type { ChannelGrant } from "../src/channel-token";

const SECRET = "s3cr3t-signing-key";

/** Forge a token from an ARBITRARY payload value + a stand-in signature — for the
 * malformed / bad-signature paths, which are decided before the signature is trusted. */
function forge(payload: unknown, signature = "AAAA"): string {
  const encoder = new TextEncoder();
  const bytes =
    typeof payload === "string" ? encoder.encode(payload) : encoder.encode(JSON.stringify(payload));

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  const b64url = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

  return `${b64url}.${signature}`;
}

describe("channel-token — mint + verify round-trip", () => {
  it("verifies a token it minted for the same (channel, mode) before it expires", async () => {
    const grant: ChannelGrant = { channel: "orders", mode: "subscribe", exp: 2_000 };
    const token = await mintChannelToken(grant, SECRET);

    const result = await verifyChannelToken(
      token,
      { channel: "orders", mode: "subscribe", now: 1_000 },
      SECRET,
    );

    expect(result).toEqual({ ok: true, grant });
  });

  it("verifies a publish-mode token too (both modes are first-class)", async () => {
    const token = await mintChannelToken(
      { channel: "orders", mode: "publish", exp: 2_000 },
      SECRET,
    );

    const result = await verifyChannelToken(
      token,
      { channel: "orders", mode: "publish", now: 1_000 },
      SECRET,
    );

    expect(result.ok).toBe(true);
  });

  it("defaults `now` to the wall clock when the caller omits it", async () => {
    // A far-future exp so the real clock cannot expire it — exercises the `?? Date.now()` default.
    const token = await mintChannelToken(
      { channel: "orders", mode: "subscribe", exp: Date.now() + 3_600_000 },
      SECRET,
    );

    const result = await verifyChannelToken(
      token,
      { channel: "orders", mode: "subscribe" },
      SECRET,
    );

    expect(result.ok).toBe(true);
  });
});

describe("channel-token — scope + expiry enforcement", () => {
  it("refuses a token for a different channel (wrong-channel)", async () => {
    const token = await mintChannelToken({ channel: "a", mode: "subscribe", exp: 2_000 }, SECRET);

    const result = await verifyChannelToken(
      token,
      { channel: "b", mode: "subscribe", now: 1_000 },
      SECRET,
    );

    expect(result).toEqual({ ok: false, reason: "wrong-channel" });
  });

  it("refuses a subscribe token presented to publish (wrong-mode)", async () => {
    const token = await mintChannelToken({ channel: "a", mode: "subscribe", exp: 2_000 }, SECRET);

    const result = await verifyChannelToken(
      token,
      { channel: "a", mode: "publish", now: 1_000 },
      SECRET,
    );

    expect(result).toEqual({ ok: false, reason: "wrong-mode" });
  });

  it("refuses an expired token, treating exp as the first expired instant (now === exp)", async () => {
    const token = await mintChannelToken({ channel: "a", mode: "subscribe", exp: 1_000 }, SECRET);

    // exp === now is expired (the boundary).
    expect(
      await verifyChannelToken(token, { channel: "a", mode: "subscribe", now: 1_000 }, SECRET),
    ).toEqual({ ok: false, reason: "expired" });

    // one tick before exp is still valid.
    expect(
      (await verifyChannelToken(token, { channel: "a", mode: "subscribe", now: 999 }, SECRET)).ok,
    ).toBe(true);
  });
});

describe("channel-token — signature integrity", () => {
  it("rejects a token whose claims were tampered with after signing (bad-signature)", async () => {
    const token = await mintChannelToken({ channel: "a", mode: "subscribe", exp: 1_000 }, SECRET);
    const signature = token.slice(token.indexOf(".") + 1);

    // Re-encode an EXTENDED grant but keep the original signature — the classic
    // "can't lengthen my own expiry" attack. Signature is over the old payload.
    const tampered = forge({ channel: "a", mode: "subscribe", exp: 9_999_999 }, signature);

    const result = await verifyChannelToken(
      tampered,
      { channel: "a", mode: "subscribe", now: 1 },
      SECRET,
    );

    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a token whose signature was flipped (bad-signature)", async () => {
    const token = await mintChannelToken({ channel: "a", mode: "subscribe", exp: 2_000 }, SECRET);
    const dot = token.indexOf(".");
    const signature = token.slice(dot + 1);
    // Flip the FIRST signature char — its 6 bits are the top 6 of byte 0, so the
    // change is guaranteed to alter a real byte (the last char's low bits are
    // non-significant padding that forgiving-base64 may ignore).
    const firstChar = signature.charAt(0);
    const flipped = `${firstChar === "A" ? "B" : "A"}${signature.slice(1)}`;

    const result = await verifyChannelToken(
      `${token.slice(0, dot)}.${flipped}`,
      { channel: "a", mode: "subscribe", now: 1_000 },
      SECRET,
    );

    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a token signed with a different secret (bad-signature)", async () => {
    const token = await mintChannelToken({ channel: "a", mode: "subscribe", exp: 2_000 }, SECRET);

    const result = await verifyChannelToken(
      token,
      { channel: "a", mode: "subscribe", now: 1_000 },
      "a-completely-different-secret",
    );

    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("treats verification under an empty secret as a rejection, never throwing (contract)", async () => {
    const token = await mintChannelToken({ channel: "a", mode: "subscribe", exp: 2_000 }, SECRET);

    // An empty HMAC key makes `crypto.subtle.importKey` throw; the "never throws"
    // contract turns that into a fail-closed `bad-signature`, not a 500.
    const result = await verifyChannelToken(
      token,
      { channel: "a", mode: "subscribe", now: 1_000 },
      "",
    );

    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });
});

describe("channel-token — malformed tokens are data, not exceptions", () => {
  it("rejects a token with no dot", async () => {
    expect(
      await verifyChannelToken("nodothere", { channel: "a", mode: "subscribe" }, SECRET),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a token with a leading dot (empty payload)", async () => {
    expect(await verifyChannelToken(".AAAA", { channel: "a", mode: "subscribe" }, SECRET)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects a token with a trailing dot (empty signature)", async () => {
    expect(await verifyChannelToken("AAAA.", { channel: "a", mode: "subscribe" }, SECRET)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects a token with more than one dot", async () => {
    expect(await verifyChannelToken("a.b.c", { channel: "a", mode: "subscribe" }, SECRET)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects a payload that is not valid base64url", async () => {
    expect(
      await verifyChannelToken("!!!!.AAAA", { channel: "a", mode: "subscribe" }, SECRET),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a signature that is not valid base64url", async () => {
    const good = await mintChannelToken({ channel: "a", mode: "subscribe", exp: 2_000 }, SECRET);
    const payloadPart = good.slice(0, good.indexOf("."));

    expect(
      await verifyChannelToken(`${payloadPart}.!!!!`, { channel: "a", mode: "subscribe" }, SECRET),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a payload that decodes but is not JSON", async () => {
    expect(
      await verifyChannelToken(forge("not json{{"), { channel: "a", mode: "subscribe" }, SECRET),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a payload that is JSON but not an object", async () => {
    expect(
      await verifyChannelToken(forge(42), { channel: "a", mode: "subscribe" }, SECRET),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a payload that is the JSON null", async () => {
    expect(
      await verifyChannelToken(forge(null), { channel: "a", mode: "subscribe" }, SECRET),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a grant missing / mistyped channel", async () => {
    expect(
      await verifyChannelToken(
        forge({ mode: "subscribe", exp: 2_000 }),
        { channel: "a", mode: "subscribe" },
        SECRET,
      ),
    ).toEqual({ ok: false, reason: "malformed" });

    expect(
      await verifyChannelToken(
        forge({ channel: 42, mode: "subscribe", exp: 2_000 }),
        { channel: "a", mode: "subscribe" },
        SECRET,
      ),
    ).toEqual({ ok: false, reason: "malformed" });

    expect(
      await verifyChannelToken(
        forge({ channel: "", mode: "subscribe", exp: 2_000 }),
        { channel: "a", mode: "subscribe" },
        SECRET,
      ),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a grant with an unknown mode", async () => {
    expect(
      await verifyChannelToken(
        forge({ channel: "a", mode: "admin", exp: 2_000 }),
        { channel: "a", mode: "subscribe" },
        SECRET,
      ),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a grant with a non-number exp", async () => {
    expect(
      await verifyChannelToken(
        forge({ channel: "a", mode: "subscribe", exp: "soon" }),
        { channel: "a", mode: "subscribe" },
        SECRET,
      ),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a grant with a non-finite exp (raw 1e400 → Infinity via JSON.parse)", async () => {
    // A raw JSON payload (not via JSON.stringify, which would coerce Infinity → null),
    // so exp decodes to Infinity — a would-be never-expiring grant, caught pre-verify.
    expect(
      await verifyChannelToken(
        forge('{"channel":"a","mode":"subscribe","exp":1e400}'),
        { channel: "a", mode: "subscribe" },
        SECRET,
      ),
    ).toEqual({ ok: false, reason: "malformed" });
  });
});
