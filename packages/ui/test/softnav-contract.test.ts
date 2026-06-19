import { describe, expect, it } from "vitest";

import { eligibleAnchor, RELOAD_ATTR } from "../src/softnav-contract";
import type { SoftNavAnchor, SoftNavClick } from "../src/softnav-contract";

/**
 * The contract is the DOM-FREE half of soft nav (`<Link>` and the browser runtime
 * both read it), so its whole point is to be exercised with plain objects and no
 * jsdom — every decline branch of `eligibleAnchor` reached through a literal click.
 */

/** A same-frame, non-download, not-opted-out anchor — the eligible default. */
const okAnchor = (over: Partial<SoftNavAnchor> = {}): SoftNavAnchor => ({
  href: "https://app.test/next",
  target: "",
  hasDownload: false,
  reload: false,
  ...over,
});

/** A plain primary-button click resolving the given anchor — the eligible default. */
const click = (over: Partial<SoftNavClick> = {}): SoftNavClick => ({
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
  anchor: () => okAnchor(),
  preventDefault: () => {},
  ...over,
});

describe("RELOAD_ATTR", () => {
  it("is the data attribute the runtime declines on", () => {
    expect(RELOAD_ATTR).toBe("data-lesto-reload");
  });
});

describe("eligibleAnchor — accepts a plain primary-button click on an eligible anchor", () => {
  it("returns the anchor", () => {
    const anchor = okAnchor();

    expect(eligibleAnchor(click({ anchor: () => anchor }))).toBe(anchor);
  });
});

describe("eligibleAnchor — declines so the browser navigates normally", () => {
  it("declines an already-defaulted event", () => {
    expect(eligibleAnchor(click({ defaultPrevented: true }))).toBeUndefined();
  });

  it("declines a non-primary (middle/right) button", () => {
    expect(eligibleAnchor(click({ button: 1 }))).toBeUndefined();
  });

  it("declines a meta-click (open in new tab)", () => {
    expect(eligibleAnchor(click({ metaKey: true }))).toBeUndefined();
  });

  it("declines a ctrl-click", () => {
    expect(eligibleAnchor(click({ ctrlKey: true }))).toBeUndefined();
  });

  it("declines a shift-click (open in new window)", () => {
    expect(eligibleAnchor(click({ shiftKey: true }))).toBeUndefined();
  });

  it("declines an alt-click (download)", () => {
    expect(eligibleAnchor(click({ altKey: true }))).toBeUndefined();
  });

  it("declines when no anchor is in the target's ancestry", () => {
    expect(eligibleAnchor(click({ anchor: () => undefined }))).toBeUndefined();
  });

  it("declines an anchor with a named target (new frame/tab)", () => {
    expect(eligibleAnchor(click({ anchor: () => okAnchor({ target: "_blank" }) }))).toBeUndefined();
  });

  it("declines a download anchor", () => {
    expect(
      eligibleAnchor(click({ anchor: () => okAnchor({ hasDownload: true }) })),
    ).toBeUndefined();
  });

  it("declines an anchor that opted out with the reload attribute", () => {
    expect(eligibleAnchor(click({ anchor: () => okAnchor({ reload: true }) }))).toBeUndefined();
  });
});
