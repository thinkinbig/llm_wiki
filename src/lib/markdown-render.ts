import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import type { PluggableList } from "unified"

const remarkBase: PluggableList = [remarkGfm, remarkMath]

/** Wiki / file preview — keep GFM lists; no remark-breaks (it merges lines into `<p><br>`). */
export const wikiMarkdownRemarkPlugins: PluggableList = remarkBase

/** Chat / research — LLM replies often use single `\n` between lines. */
export const chatMarkdownRemarkPlugins: PluggableList = [...remarkBase, remarkBreaks]

/** @deprecated Use wikiMarkdownRemarkPlugins or chatMarkdownRemarkPlugins */
export const markdownRemarkPlugins = chatMarkdownRemarkPlugins

export const markdownRehypePlugins: PluggableList = [rehypeKatex]

/**
 * Normalize markdown before ReactMarkdown.
 *
 * - `<br />` → newline, then blank-line normalization.
 * - Unicode bullets (• · …) → `- ` so GFM list parsing matches Milkdown edit view.
 * - Fenced code blocks are untouched.
 */
export function prepareMarkdownForRender(markdown: string): string {
  const withNewlines = markdown.replace(/<br\s*\/?>\s*/gi, "\n")
  return normalizeBlankLinesOutsideFences(promoteStandaloneBoldHeadings(withNewlines))
}

/** LLM replies often use a lone `**Section**` line instead of `## Section`. */
function promoteStandaloneBoldHeadings(text: string): string {
  // Do not use `\s` before `$` — it would swallow following newlines.
  return text.replace(/^\*\*([^*\n]+)\*\*[ \t]*$/gm, "## $1")
}

/** Common LLM / Word bullets that GFM does not treat as list markers. */
const UNICODE_BULLET_RE =
  /^(\s*)[\u2022\u00b7\u25aa\u25ab\u2023\u2043\u2219\u25e6\u2013\u2014]\s+/gm

function normalizeListMarkers(text: string): string {
  let t = text.replace(UNICODE_BULLET_RE, "$1- ")
  // Indented `-` / `*` lines are parsed as code blocks; pull them to column 0.
  t = t.replace(/^[\t ]{1,4}([-*+])\s+/gm, "$1 ")
  return t
}

function normalizeBlankLinesOutsideFences(markdown: string): string {
  const parts = markdown.split(/(```[\s\S]*?```)/g)
  return parts
    .map((part, idx) =>
      idx % 2 === 1 ? part : normalizeBlankRuns(normalizeListMarkers(part)),
    )
    .join("")
}

/** One extra blank line per run — never multiple nbsp paragraphs per run. */
const ONE_EXTRA_GAP = "\n\n\u00a0\n\n"

function normalizeBlankRuns(text: string): string {
  let t = text.replace(/^((?:\r?\n){2,})/, ONE_EXTRA_GAP)
  t = t.replace(/(?:\r?\n){3,}/g, (match, offset, string) => {
    if (isBlankRunBetweenListItems(string, offset, match.length)) return "\n\n"
    return ONE_EXTRA_GAP
  })
  return t
}

/** Keep list blocks contiguous — do not inject nbsp between `-` items. */
function isBlankRunBetweenListItems(
  text: string,
  offset: number,
  runLength: number,
): boolean {
  const before = text.slice(0, offset)
  const after = text.slice(offset + runLength)
  const prevLine = before.split(/\r?\n/).pop() ?? ""
  const nextLine = after.match(/^[^\r\n]*/)?.[0] ?? ""
  return /^\s*[-*+]\s+\S/.test(prevLine) && /^\s*[-*+]\s+\S/.test(nextLine)
}
