// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CheckIcon,
  CodeBlock,
  CopyIcon,
  resolveCopyText,
  XIcon,
} from "../src/components/CodeBlock";

// ---------------------------------------------------------------------------
// React 19 in a jsdom document; we mount with createRoot inside act() so the
// committed DOM is settled before assertions — mirroring packages/ui.
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // React's act() warning is silenced by this global flag in test envs.
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function render(node: ReactElement) {
  act(() => root.render(node));
}

/** Stub navigator.clipboard.writeText with a controllable promise. */
function stubClipboard(impl: () => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(impl) },
  });

  return (navigator.clipboard as unknown as { writeText: ReturnType<typeof vi.fn> }).writeText;
}

describe("CodeBlock", () => {
  it("renders a pre wrapping its children plus a default copy button", () => {
    render(createElement(CodeBlock, null, createElement("code", null, "const x = 1;")));

    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe("const x = 1;");

    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Copy code");
    // Default (no custom class) -> inline styles applied, positioned wrapper.
    expect((container.querySelector("div") as HTMLDivElement).style.position).toBe("relative");
  });

  it("hides the copy button when hideCopyButton is set", () => {
    render(createElement(CodeBlock, { hideCopyButton: true }, "x"));

    expect(container.querySelector("button")).toBeNull();
  });

  it("copies the code element's text and shows the success state", async () => {
    const writeText = stubClipboard(() => Promise.resolve());

    render(createElement(CodeBlock, null, createElement("code", null, "copy me")));

    const button = container.querySelector("button") as HTMLButtonElement;

    await act(async () => {
      button.click();
    });

    expect(writeText).toHaveBeenCalledWith("copy me");
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Copied!");
    // Success icon is the check polyline.
    expect(container.querySelector("polyline")).not.toBeNull();
  });

  it("falls back to the pre's textContent when there is no code element", async () => {
    const writeText = stubClipboard(() => Promise.resolve());

    render(createElement(CodeBlock, null, "bare text"));

    const button = container.querySelector("button") as HTMLButtonElement;

    await act(async () => {
      button.click();
    });

    expect(writeText).toHaveBeenCalledWith("bare text");
  });

  it("copies an empty string when neither code nor pre has text", async () => {
    const writeText = stubClipboard(() => Promise.resolve());

    render(createElement(CodeBlock, null));

    const button = container.querySelector("button") as HTMLButtonElement;

    await act(async () => {
      button.click();
    });

    expect(writeText).toHaveBeenCalledWith("");
  });

  it("shows the failure state when the clipboard write rejects", async () => {
    stubClipboard(() => Promise.reject(new Error("denied")));

    render(createElement(CodeBlock, null, createElement("code", null, "x")));

    const button = container.querySelector("button") as HTMLButtonElement;

    await act(async () => {
      button.click();
    });

    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Copy failed");
    // Failure icon is two crossing lines.
    expect(container.querySelectorAll("line").length).toBe(2);
  });

  it("reverts the success state after the feedback timeout", async () => {
    vi.useFakeTimers();
    stubClipboard(() => Promise.resolve());

    render(createElement(CodeBlock, null, createElement("code", null, "x")));

    const button = container.querySelector("button") as HTMLButtonElement;

    await act(async () => {
      button.click();
      // Flush the resolved clipboard promise before advancing timers.
      await Promise.resolve();
    });

    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Copied!");

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Copy code");
  });

  it("clears a pending timeout when copied again in quick succession", async () => {
    vi.useFakeTimers();
    stubClipboard(() => Promise.resolve());

    render(createElement(CodeBlock, null, createElement("code", null, "x")));

    const button = container.querySelector("button") as HTMLButtonElement;

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    // Second click before the first timeout fires must clear the stale timer.
    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Copied!");
  });

  it("reverts the failure state after the feedback timeout", async () => {
    vi.useFakeTimers();
    stubClipboard(() => Promise.reject(new Error("nope")));

    render(createElement(CodeBlock, null, createElement("code", null, "x")));

    const button = container.querySelector("button") as HTMLButtonElement;

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Copy failed");

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Copy code");
  });

  it("applies the caller's button class and omits inline default styles", () => {
    render(
      createElement(CodeBlock, {
        buttonClassName: "my-btn",
        buttonStyle: { color: "blue" },
      }),
    );

    const button = container.querySelector("button") as HTMLButtonElement;

    expect(button.className).toBe("my-btn");
    // With a custom class, only buttonStyle is applied (not the default block).
    expect(button.style.color).toBe("blue");
    expect(button.style.position).toBe("");
  });

  it("applies the wrapper class and merges custom wrapper styles", () => {
    render(
      createElement(CodeBlock, {
        wrapperClassName: "wrap",
        wrapperStyle: { background: "red" },
      }),
    );

    const wrapper = container.querySelector("div") as HTMLDivElement;

    expect(wrapper.className).toBe("wrap");
    expect(wrapper.style.position).toBe("relative");
    expect(wrapper.style.background).toBe("red");
  });

  it("renders a custom copy button via renderCopyButton and wires onCopy", async () => {
    const writeText = stubClipboard(() => Promise.resolve());

    render(
      createElement(CodeBlock, {
        renderCopyButton: ({ copied, copyFailed, onCopy }) =>
          createElement(
            "button",
            { "data-testid": "custom", "data-copied": String(copied), onClick: onCopy },
            copyFailed ? "failed" : "custom copy",
          ),
        children: createElement("code", null, "snippet"),
      }),
    );

    const custom = container.querySelector('[data-testid="custom"]') as HTMLButtonElement;
    expect(custom.textContent).toBe("custom copy");

    await act(async () => {
      custom.click();
    });

    expect(writeText).toHaveBeenCalledWith("snippet");
    expect(
      (container.querySelector('[data-testid="custom"]') as HTMLButtonElement).getAttribute(
        "data-copied",
      ),
    ).toBe("true");
  });

  it("cleans up a pending timeout on unmount without firing it", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    stubClipboard(() => Promise.resolve());

    render(createElement(CodeBlock, null, createElement("code", null, "x")));

    const button = container.querySelector("button") as HTMLButtonElement;

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    act(() => root.unmount());

    // The unmount cleanup clears the still-pending feedback timer.
    expect(clearSpy).toHaveBeenCalled();

    // Re-create a root so afterEach's unmount is a no-op rather than a throw.
    root = createRoot(container);
  });
});

describe("resolveCopyText", () => {
  it("prefers the inner code element's text", () => {
    const pre = document.createElement("pre");
    pre.innerHTML = "<code>inner code</code>";
    pre.append(" trailing");

    expect(resolveCopyText(pre)).toBe("inner code");
  });

  it("falls back to the pre's own text when there is no code element", () => {
    const pre = document.createElement("pre");
    pre.textContent = "plain pre text";

    expect(resolveCopyText(pre)).toBe("plain pre text");
  });

  it("returns an empty string when the ref has not attached", () => {
    expect(resolveCopyText(null)).toBe("");
  });
});

describe("icon exports", () => {
  it("renders each standalone icon as an svg", () => {
    for (const Icon of [CopyIcon, CheckIcon, XIcon]) {
      const div = document.createElement("div");
      document.body.appendChild(div);
      const r = createRoot(div);

      act(() => r.render(createElement(Icon)));

      expect(div.querySelector("svg")).not.toBeNull();

      act(() => r.unmount());
      div.remove();
    }
  });
});
