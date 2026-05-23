import React from "react"
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import {
  prepareMarkdownForRender,
  wikiMarkdownRemarkPlugins,
  chatMarkdownRemarkPlugins,
  markdownRehypePlugins,
} from "@/lib/markdown-render"

function renderWiki(body: string): string {
  return renderToStaticMarkup(
    React.createElement(ReactMarkdown, {
      remarkPlugins: wikiMarkdownRemarkPlugins,
      rehypePlugins: markdownRehypePlugins,
    }, prepareMarkdownForRender(body)),
  )
}

function renderChat(body: string): string {
  return renderToStaticMarkup(
    React.createElement(ReactMarkdown, {
      remarkPlugins: chatMarkdownRemarkPlugins,
      rehypePlugins: markdownRehypePlugins,
    }, prepareMarkdownForRender(body)),
  )
}

describe("prepareMarkdownForRender", () => {
  it("promotes standalone bold lines to h2 markdown", () => {
    expect(prepareMarkdownForRender("**关系与联系**\n\n正文")).toBe(
      "## 关系与联系\n\n正文",
    )
  })

  it("maps br tags to newlines then normalizes leading gaps", () => {
    expect(prepareMarkdownForRender("<br /><br /> test")).toBe("\n\n\u00a0\n\ntest")
    expect(prepareMarkdownForRender("line1<br />line2")).toBe("line1\nline2")
  })

  it("converts unicode bullets to GFM list markers", () => {
    expect(prepareMarkdownForRender("• one\n• two")).toBe("- one\n- two")
    expect(prepareMarkdownForRender("– one\n— two")).toBe("- one\n- two")
  })

  it("pulls indented list markers out of code-block indentation", () => {
    expect(prepareMarkdownForRender("\t- one\n\t- two")).toBe("- one\n- two")
  })

  it("adds at most one extra gap for 3+ internal newlines", () => {
    expect(prepareMarkdownForRender("a\n\n\nb")).toBe("a\n\n\u00a0\n\nb")
    expect(prepareMarkdownForRender("a\n\n\n\n\nb")).toBe("a\n\n\u00a0\n\nb")
    expect(prepareMarkdownForRender("para one\n\npara two")).toBe("para one\n\npara two")
  })

  it("does not inject nbsp between list items separated by extra blank lines", () => {
    expect(prepareMarkdownForRender("- one\n\n\n- two")).toBe("- one\n\n- two")
  })

  it("does not touch fenced code", () => {
    const input = "```\na\n\n\nb\n```\n\n\nafter"
    expect(prepareMarkdownForRender(input)).toBe(
      "```\na\n\n\nb\n```\n\n\u00a0\n\nafter",
    )
  })
})

describe("wiki markdown render", () => {
  it("renders GFM bullet lists", () => {
    const html = renderWiki("- one\n- two")
    expect(html).toContain("<ul>")
    expect(html).toContain("<li>one</li>")
  })

  it("renders unicode bullet lists after normalization", () => {
    const html = renderWiki("• Highly durable\n• Central to decoupling")
    expect(html).toContain("<ul>")
    expect(html).not.toMatch(/<p>•/)
  })

  it("renders tab-indented hyphen lists as ul not code block", () => {
    const html = renderWiki("\t- one\n\t- two")
    expect(html).toContain("<ul>")
    expect(html).not.toContain("<pre>")
  })

  it("does not merge list lines into a single paragraph with br", () => {
    const html = renderWiki("- one\n- two")
    expect(html).not.toContain("<br")
  })
})

describe("chat markdown render", () => {
  it("emits heading elements for ATX markdown headings", () => {
    const html = renderChat("## 关系与联系\n\n正文")
    expect(html).toContain("<h2>关系与联系</h2>")
    expect(html).toContain("<p>正文</p>")
  })

  it("renders promoted bold-only lines as headings", () => {
    const html = renderChat("**引用要点**\n\n- one")
    expect(html).toContain("<h2>引用要点</h2>")
    expect(html).toContain("<ul>")
  })

  it("renders single newlines as br (remark-breaks)", () => {
    const html = renderChat("Line A\nLine B")
    expect(html).toMatch(/<br\s*\/?>/)
  })

  it("renders leading br pair as spacer before text", () => {
    expect(renderChat("<br /><br /> test")).toBe(
      "<p>\u00a0</p>\n<p>test</p>",
    )
  })
})
