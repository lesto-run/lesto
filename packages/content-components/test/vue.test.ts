import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vitest";

import { HtmlContent } from "../vue/HtmlContent";

interface RenderProps {
  html: string;
  class?: string;
  unsanitized?: boolean;
}

/** Server-render the component with the given props into an HTML string. */
function render(props: RenderProps): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(HtmlContent, props) }));
}

describe("Vue HtmlContent", () => {
  it("sanitizes dangerous markup before setting innerHTML", async () => {
    const html = `<p>safe</p><script>alert(1)</script><img src=x onerror="x()">`;

    const markup = await render({ html, class: "prose" });

    expect(markup).toContain("<p>safe</p>");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("onerror");
    // The forwarded class lands on the wrapper div.
    expect(markup).toContain('class="prose"');
  });

  it("renders raw html verbatim when unsanitized is set", async () => {
    const markup = await render({
      html: `<script>danger</script><b>bold</b>`,
      unsanitized: true,
    });

    expect(markup).toContain("<script>danger</script>");
    expect(markup).toContain("<b>bold</b>");
  });

  it("renders with no meaningful class when none is provided", async () => {
    // Vue's class binding serializes an undefined class prop as an empty
    // attribute (class=""); the point is no caller-supplied class leaks in.
    const markup = await render({ html: "<i>hi</i>" });

    expect(markup).toContain("<i>hi</i>");
    expect(markup).toMatch(/^<div class=""><i>hi<\/i><\/div>$/);
  });
});
