import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders a GFM pipe table as a real <table>", () => {
    const html = renderMarkdown(
      ["| Priority | Count |", "| --- | --- |", "| P0 | 1 |"].join("\n"),
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<th>Priority</th>");
    expect(html).toContain("<td>P0</td>");
  });

  it("passes a report's <details>/<summary> collapsible section through unchanged", () => {
    const html = renderMarkdown(
      "<details>\n<summary>Architecture (done)</summary>\n\nLooks fine.\n\n</details>",
    );
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>Architecture (done)</summary>");
    expect(html).toContain("Looks fine.");
  });

  it("strips a script tag embedded in reviewer-authored text", () => {
    const html = renderMarkdown(
      'Suspicious finding <script>alert("xss")</script> in this file.',
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(");
  });

  it("strips an inline event-handler attribute embedded in reviewer-authored text", () => {
    const html = renderMarkdown(
      '<img src="x" onerror="alert(1)"> found in diff',
    );
    expect(html).not.toContain("onerror");
  });

  it("renders an ordinary heading and paragraph", () => {
    const html = renderMarkdown("# Title\n\nSome body text.");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<p>Some body text.</p>");
  });
});
