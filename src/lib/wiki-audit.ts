/**
 * Deterministic wiki defect detectors (from eval/wiki-defect-patterns.jsonl).
 * Shared by in-app lint and the eval/audit-wiki-defects CLI.
 */

import { parseFrontmatter } from "@/lib/frontmatter"
import { dedupKey, pageId } from "@/lib/page-id"
import { parseFrontmatterArray } from "@/lib/sources-merge"
import { resolveWikiSlugId, unwrapWikilink } from "@/lib/wiki-page-resolver"
import { normalizePath } from "@/lib/path-utils"

const STUB_MARKER = "_Stub page — batched ingest did not emit this file"
const KEBAB_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g

/** Pattern ids with no automated detector yet. */
export const WIKI_AUDIT_UNDETECTED = [
  "WIKI-DUP-TYPO",
  "WIKI-DUP-SEMANTIC",
  "WIKI-CONTENT-HALLUCINATION",
] as const

/** Lint severity for each automated pattern id. */
export const WIKI_AUDIT_PATTERN_SEVERITY: Record<string, "warning" | "info"> = {
  "WIKI-DUP-SLUG-PUNCTUATION": "warning",
  "WIKI-DUP-SLUG-VERSION-NUMBER": "warning",
  "WIKI-DUP-SLUG-CASE": "warning",
  "WIKI-DUP-SLUG-TRUNCATION": "warning",
  "WIKI-STUB-UNFILLED": "warning",
  "WIKI-PAGE-EMPTY": "warning",
  "WIKI-FRONTMATTER-DELIMITER-WHITESPACE": "warning",
  "WIKI-CONTENT-HALLUCINATION": "warning",
  "WIKI-FRONTMATTER-INCONSISTENT-LIST": "warning",
  "WIKI-LINK-BROKEN-NONEXISTENT": "warning",
  "WIKI-LINK-TITLE-FORM": "warning",
  "WIKI-LINK-CASE-MISMATCH": "warning",
  "WIKI-LINK-MALFORMED-TEXT": "warning",
  "WIKI-LINK-SELF-REFERENCE": "info",
  "WIKI-MISSING-PAGE-PLACEHOLDER": "warning",
  "WIKI-INDEX-STALE": "warning",
  "WIKI-LOG-DUPLICATE-ENTRY": "info",
  "WIKI-TITLE-SLUG-MISMATCH": "warning",
  "WIKI-TYPE-COLLISION": "info",
  "WIKI-METADATA-INCONSISTENT-DATES": "info",
}

export interface WikiAuditFs {
  readdir: (dir: string) => Promise<string[]>
  readFile: (path: string) => Promise<string>
}

export interface WikiAuditPage {
  rel: string
  slug: string
  dir: "concepts" | "entities"
  content: string
  title: string | null
}

export interface WikiAuditFinding {
  id: string
  detail: string
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const item of items) {
    const k = keyFn(item)
    const arr = m.get(k) ?? []
    arr.push(item)
    m.set(k, arr)
  }
  return m
}

function isKebabSlug(s: string): boolean {
  const { slug } = unwrapWikilink(s.trim())
  return KEBAB_SLUG_RE.test(slug)
}

function collectWikilinks(body: string): Array<{ target: string; display: string | null }> {
  const out: Array<{ target: string; display: string | null }> = []
  for (const m of body.matchAll(WIKILINK_RE)) {
    out.push({ target: m[1].trim(), display: m[2]?.trim() ?? null })
  }
  return out
}

function slugifyTitle(title: string): string {
  return pageId(title)
}

/** Page field for lint UI — first path-like segment in detail, else wiki-level. */
export function pageFromAuditDetail(detail: string): string {
  const m = detail.match(/^(concepts|entities)\/[^\s]+/)
  if (m) return m[0]
  if (detail.startsWith("index.md") || detail.includes("index.md")) return "index.md"
  if (detail.includes("log.md")) return "log.md"
  return "wiki"
}

/** Accept project root (`…/project`) or wiki root (`…/wiki/concepts`). */
export async function resolveWikiRoot(
  inputPath: string,
  fs: WikiAuditFs,
): Promise<string> {
  const pp = normalizePath(inputPath)
  try {
    await fs.readdir(`${pp}/concepts`)
    return pp
  } catch {
    /* not a wiki root */
  }
  const nested = `${pp}/wiki`
  try {
    await fs.readdir(`${nested}/concepts`)
    return nested
  } catch {
    return nested
  }
}

export async function loadWikiAuditPages(
  wikiRoot: string,
  fs: WikiAuditFs,
): Promise<WikiAuditPage[]> {
  const pages: WikiAuditPage[] = []
  for (const dir of ["concepts", "entities"] as const) {
    const folder = `${wikiRoot}/${dir}`
    let entries: string[]
    try {
      entries = await fs.readdir(folder)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.endsWith(".md")) continue
      const abs = `${folder}/${name}`
      const content = await fs.readFile(abs)
      const { frontmatter } = parseFrontmatter(content)
      pages.push({
        rel: `${dir}/${name}`,
        slug: name.replace(/\.md$/i, ""),
        dir,
        content,
        title: typeof frontmatter?.title === "string" ? frontmatter.title : null,
      })
    }
  }
  return pages
}

export async function auditWikiPages(
  pages: WikiAuditPage[],
  wikiRoot: string,
  fs: Pick<WikiAuditFs, "readFile">,
): Promise<Record<string, WikiAuditFinding[]>> {
  const knownIds = pages.map((p) => p.slug)
  const knownSet = new Set(knownIds)
  const findings: Record<string, WikiAuditFinding[]> = {}

  const ensure = (id: string) => {
    if (!findings[id]) findings[id] = []
  }

  const byDedupKey = groupBy(pages, (p) => dedupKey(p.slug))
  for (const [key, group] of byDedupKey) {
    const distinctSlugs = [...new Set(group.map((p) => p.slug))]
    if (distinctSlugs.length < 2) continue
    const slugs = distinctSlugs.sort()
    const hasVersionDigits = /\d/.test(key)
    const hasCaseOnly =
      new Set(group.map((p) => p.slug.toLowerCase())).size === 1 &&
      new Set(group.map((p) => p.slug)).size > 1
    const hasTruncation = group.some((a) =>
      group.some(
        (b) =>
          a.slug !== b.slug &&
          b.slug.startsWith(a.slug) &&
          a.slug.length < b.slug.length,
      ),
    )

    const detail = `${distinctSlugs.length} slugs share dedupKey "${key}": ${slugs.join(", ")}`
    ensure("WIKI-DUP-SLUG-PUNCTUATION")
    findings["WIKI-DUP-SLUG-PUNCTUATION"].push({ id: "WIKI-DUP-SLUG-PUNCTUATION", detail })
    if (hasVersionDigits) {
      ensure("WIKI-DUP-SLUG-VERSION-NUMBER")
      findings["WIKI-DUP-SLUG-VERSION-NUMBER"].push({
        id: "WIKI-DUP-SLUG-VERSION-NUMBER",
        detail,
      })
    }
    if (hasCaseOnly) {
      ensure("WIKI-DUP-SLUG-CASE")
      findings["WIKI-DUP-SLUG-CASE"].push({ id: "WIKI-DUP-SLUG-CASE", detail })
    }
    if (hasTruncation) {
      ensure("WIKI-DUP-SLUG-TRUNCATION")
      findings["WIKI-DUP-SLUG-TRUNCATION"].push({ id: "WIKI-DUP-SLUG-TRUNCATION", detail })
    }
  }

  for (const page of pages) {
    const { body } = parseFrontmatter(page.content)
    const bodyTrim = body.trim()

    if (page.content.includes(STUB_MARKER)) {
      ensure("WIKI-STUB-UNFILLED")
      findings["WIKI-STUB-UNFILLED"].push({ id: "WIKI-STUB-UNFILLED", detail: page.rel })
    }

    if (bodyTrim.length === 0) {
      ensure("WIKI-PAGE-EMPTY")
      findings["WIKI-PAGE-EMPTY"].push({ id: "WIKI-PAGE-EMPTY", detail: page.rel })
    }

    const firstLine = page.content.split(/\r?\n/)[0] ?? ""
    if (firstLine !== "---" && firstLine.trim() === "---") {
      ensure("WIKI-FRONTMATTER-DELIMITER-WHITESPACE")
      findings["WIKI-FRONTMATTER-DELIMITER-WHITESPACE"].push({
        id: "WIKI-FRONTMATTER-DELIMITER-WHITESPACE",
        detail: `${page.rel} opening="${firstLine}"`,
      })
    }

    if (page.slug.startsWith("missing-page-")) {
      ensure("WIKI-MISSING-PAGE-PLACEHOLDER")
      findings["WIKI-MISSING-PAGE-PLACEHOLDER"].push({
        id: "WIKI-MISSING-PAGE-PLACEHOLDER",
        detail: page.rel,
      })
    }

    if (page.title) {
      const fromTitle = slugifyTitle(page.title)
      // pageId can hyphenate acronyms differently than ingest filenames
      // (e.g. "2PC" → pageId "…-2-pc" vs slug "…-2pc"). dedupKey is the
      // orthographic identity — same key means title and slug agree.
      if (
        fromTitle &&
        fromTitle !== page.slug &&
        dedupKey(fromTitle) !== dedupKey(page.slug)
      ) {
        const titleTokens = new Set(fromTitle.split("-"))
        const slugTokens = page.slug.split("-")
        const extra = slugTokens.filter((t) => !titleTokens.has(t))
        if (extra.length > 0) {
          ensure("WIKI-TITLE-SLUG-MISMATCH")
          findings["WIKI-TITLE-SLUG-MISMATCH"].push({
            id: "WIKI-TITLE-SLUG-MISMATCH",
            detail: `${page.rel} title="${page.title}" slug="${page.slug}" extra=[${extra.join(",")}]`,
          })
        }
      }
    }

    for (const raw of parseFrontmatterArray(page.content, "related")) {
      if (!isKebabSlug(raw)) {
        ensure("WIKI-FRONTMATTER-INCONSISTENT-LIST")
        findings["WIKI-FRONTMATTER-INCONSISTENT-LIST"].push({
          id: "WIKI-FRONTMATTER-INCONSISTENT-LIST",
          detail: `${page.rel} related=${JSON.stringify(raw)}`,
        })
      }
    }

    for (const { target } of collectWikilinks(body)) {
      const norm = target.toLowerCase().replace(/\s+/g, "-")
      const resolved = resolveWikiSlugId(target, knownIds)

      if (target === page.slug || norm === page.slug) {
        ensure("WIKI-LINK-SELF-REFERENCE")
        findings["WIKI-LINK-SELF-REFERENCE"].push({
          id: "WIKI-LINK-SELF-REFERENCE",
          detail: `${page.rel} → [[${target}]]`,
        })
      }

      if (/[\[\(]/.test(target) && !/^\[\[/.test(target)) {
        ensure("WIKI-LINK-MALFORMED-TEXT")
        findings["WIKI-LINK-MALFORMED-TEXT"].push({
          id: "WIKI-LINK-MALFORMED-TEXT",
          detail: `${page.rel} → [[${target}]]`,
        })
      }

      if (resolved === null) {
        if (knownSet.has(norm)) {
          ensure("WIKI-LINK-CASE-MISMATCH")
          findings["WIKI-LINK-CASE-MISMATCH"].push({
            id: "WIKI-LINK-CASE-MISMATCH",
            detail: `${page.rel} → [[${target}]] (ci match: ${norm})`,
          })
        } else if (/[A-Z\s]/.test(target) || target.includes("(")) {
          ensure("WIKI-LINK-TITLE-FORM")
          findings["WIKI-LINK-TITLE-FORM"].push({
            id: "WIKI-LINK-TITLE-FORM",
            detail: `${page.rel} → [[${target}]]`,
          })
        } else {
          ensure("WIKI-LINK-BROKEN-NONEXISTENT")
          findings["WIKI-LINK-BROKEN-NONEXISTENT"].push({
            id: "WIKI-LINK-BROKEN-NONEXISTENT",
            detail: `${page.rel} → [[${target}]]`,
          })
        }
      }
    }
  }

  const conceptSlugs = new Set(pages.filter((p) => p.dir === "concepts").map((p) => p.slug))
  for (const slug of pages.filter((p) => p.dir === "entities").map((p) => p.slug)) {
    if (conceptSlugs.has(slug)) {
      ensure("WIKI-TYPE-COLLISION")
      findings["WIKI-TYPE-COLLISION"].push({ id: "WIKI-TYPE-COLLISION", detail: slug })
    }
  }

  try {
    const index = await fs.readFile(`${wikiRoot}/index.md`)
    const indexLines = index.split(/\r?\n/).length
    const conceptLines = (index.match(/^-\s+\[\[/gm) ?? []).length
    if (pages.length > 50 && conceptLines < pages.length * 0.5) {
      ensure("WIKI-INDEX-STALE")
      findings["WIKI-INDEX-STALE"].push({
        id: "WIKI-INDEX-STALE",
        detail: `index.md ${indexLines} lines, ${conceptLines} listed pages, ${pages.length} on disk`,
      })
    }
  } catch {
    ensure("WIKI-INDEX-STALE")
    findings["WIKI-INDEX-STALE"].push({
      id: "WIKI-INDEX-STALE",
      detail: "wiki/index.md missing",
    })
  }

  try {
    const log = await fs.readFile(`${wikiRoot}/log.md`)
    const lines = log.split(/\r?\n/).filter((l) => l.trim().length > 0)
    const seen = new Map<string, number>()
    for (const line of lines) {
      seen.set(line, (seen.get(line) ?? 0) + 1)
    }
    for (const [line, count] of seen) {
      if (count > 1) {
        ensure("WIKI-LOG-DUPLICATE-ENTRY")
        findings["WIKI-LOG-DUPLICATE-ENTRY"].push({
          id: "WIKI-LOG-DUPLICATE-ENTRY",
          detail: `${count}x ${line.slice(0, 80)}`,
        })
      }
    }
  } catch {
    // log optional
  }

  const createdCounts = new Map<string, number>()
  for (const page of pages) {
    const { frontmatter } = parseFrontmatter(page.content)
    const created =
      typeof frontmatter?.created === "string" ? frontmatter.created : "(missing)"
    createdCounts.set(created, (createdCounts.get(created) ?? 0) + 1)
  }
  const distinctCreated = [...createdCounts.entries()]
    .filter(([d]) => d !== "(missing)")
    .sort((a, b) => b[1] - a[1])
  if (distinctCreated.length > 3) {
    ensure("WIKI-METADATA-INCONSISTENT-DATES")
    findings["WIKI-METADATA-INCONSISTENT-DATES"].push({
      id: "WIKI-METADATA-INCONSISTENT-DATES",
      detail: distinctCreated
        .slice(0, 8)
        .map(([d, n]) => `${d}:${n}`)
        .join(", "),
    })
  }

  for (const id of WIKI_AUDIT_UNDETECTED) {
    if (!findings[id]) findings[id] = []
  }

  return findings
}
