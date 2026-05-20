/**
 * Canonical semantics for wiki structural files (`wiki/index.md`,
 * `wiki/log.md`). Karpathy-style contracts live here so prompts, ingest,
 * chat save, review actions, and source lifecycle all speak the same
 * format.
 *
 * Log: append-only, newest entries at the **end** of the file (so
 * `grep '^## \\[' wiki/log.md | tail -5` shows recent activity).
 * Entry header: `## [YYYY-MM-DD] <action> | <subject>`
 *
 * Index: full-catalog listing at `wiki/index.md`, grouped by `## Section`
 * headers. Each line: `- [[wikilink]] — one-line description`
 */

import { normalizePath } from "@/lib/path-utils"

/** Single catalog of all wiki pages (not nested index files). */
export const WIKI_INDEX_PATH = "wiki/index.md"

/** Append-only activity timeline for the project. */
export const WIKI_LOG_PATH = "wiki/log.md"

export const WIKI_OVERVIEW_PATH = "wiki/overview.md"

export type LogAction =
  | "ingest"
  | "query"
  | "lint"
  | "delete"
  | "merge"
  | "research"
  | "manual"
  | "save"
  | "create"

/** Index section titles (must match new-project template in project.rs). */
export const INDEX_SECTIONS = [
  "Entities",
  "Concepts",
  "Sources",
  "Queries",
  "Comparisons",
  "Synthesis",
] as const

export type IndexSection = (typeof INDEX_SECTIONS)[number]

const LOG_HEADER_RE = /^##\s+\[(\d{4}-\d{2}-\d{2})\]\s+([^|\n]+)\s*\|\s*(.+)\s*$/

const LEGACY_LOG_HEADER_RE = /^##\s+(\d{4}-\d{2}-\d{2})(?:\s+|$)/

const LEGACY_BULLET_LOG_RE =
  /^-\s*(\d{4}-\d{2}-\d{2})(?::|\s+)\s*(.+)$/

/** Prompt fragment reused by ingest / manual save instructions. */
export const LOG_ENTRY_FORMAT_SPEC =
  "Log entry (append ONLY this block for wiki/log.md — no file title, no preamble):" +
  "\n```" +
  "\n## [YYYY-MM-DD] <action> | <short subject>" +
  "\n" +
  "\nOptional one or more body lines (details, bullet lists)." +
  "\n```" +
  "\nActions: ingest | query | lint | delete | merge | research | manual | save | create." +
  "\nExample: ## [2026-05-21] ingest | paper.pdf"

/** Prompt fragment for index listing lines inside a full index.md rewrite. */
export const INDEX_ENTRY_FORMAT_SPEC =
  "Each index line under a `## Entities` / `## Concepts` / … section:" +
  "\n`- [[page-slug]] — one-line description`" +
  "\nor `- [[folder/slug|Display title]] — one-line description` when the path is not at wiki root."

export function isCanonicalWikiLogPath(relativePath: string): boolean {
  return normalizePath(relativePath) === WIKI_LOG_PATH
}

export function isCanonicalWikiIndexPath(relativePath: string): boolean {
  return normalizePath(relativePath) === WIKI_INDEX_PATH
}

export function isCanonicalWikiOverviewPath(relativePath: string): boolean {
  return normalizePath(relativePath) === WIKI_OVERVIEW_PATH
}

export function indexSectionForPageType(
  pageType: string,
): IndexSection | "Queries" {
  switch (pageType) {
    case "entity":
      return "Entities"
    case "concept":
      return "Concepts"
    case "source":
      return "Sources"
    case "comparison":
      return "Comparisons"
    case "synthesis":
      return "Synthesis"
    default:
      return "Queries"
  }
}

export function formatLogEntry(
  action: LogAction,
  subject: string,
  options: { date?: string; body?: string } = {},
): string {
  const date = options.date ?? defaultToday()
  const safeSubject = subject.replace(/\|/g, "/").trim() || "(untitled)"
  const header = `## [${date}] ${action} | ${safeSubject}`
  const body = options.body?.trim()
  return body ? `${header}\n\n${body}` : header
}

/**
 * Normalize LLM or legacy UI output into a canonical log entry before append.
 */
export function normalizeLogAppendContent(
  raw: string,
  fallback: { action: LogAction; subject: string; date?: string },
): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    return formatLogEntry(fallback.action, fallback.subject, {
      date: fallback.date,
    })
  }

  const lines = trimmed.split("\n")
  const first = lines[0]?.trim() ?? ""

  const canonical = first.match(LOG_HEADER_RE)
  if (canonical) {
    return trimmed
  }

  const legacyHeader = first.match(LEGACY_LOG_HEADER_RE)
  if (legacyHeader) {
    const rest = lines.slice(1).join("\n").trim()
    return formatLogEntry(fallback.action, fallback.subject, {
      date: legacyHeader[1],
      body: rest || undefined,
    })
  }

  const legacyBullet = first.match(LEGACY_BULLET_LOG_RE)
  if (legacyBullet && lines.length === 1) {
    return formatLogEntry(fallback.action, legacyBullet[2].trim(), {
      date: legacyBullet[1],
    })
  }

  if (legacyBullet) {
    const body = [legacyBullet[2], ...lines.slice(1)].join("\n").trim()
    return formatLogEntry(fallback.action, fallback.subject, {
      date: legacyBullet[1],
      body: body || undefined,
    })
  }

  return formatLogEntry(fallback.action, fallback.subject, {
    date: fallback.date,
    body: trimmed,
  })
}

/** Append one normalized entry to existing log file content. */
export function appendWikiLogContent(existing: string, entry: string): string {
  const base = existing.trimEnd()
  const block = entry.trim()
  if (!base) return `${block}\n`
  return `${base}\n\n${block}\n`
}

export function formatIndexEntry(
  linkTarget: string,
  description: string,
  options: { displayTitle?: string } = {},
): string {
  const target = linkTarget.replace(/^\[\[|\]\]$/g, "").trim()
  const desc = description.trim() || "(no description)"
  if (options.displayTitle && options.displayTitle !== target) {
    return `- [[${target}|${options.displayTitle}]] — ${desc}`
  }
  return `- [[${target}]] — ${desc}`
}

/**
 * Insert one index line directly under a section header (newest line first
 * within the section). Creates the section when missing.
 */
export function appendIndexEntry(
  indexContent: string,
  section: IndexSection | string,
  entryLine: string,
): string {
  const header = `## ${section}`
  const line = entryLine.trim()
  if (!line) return indexContent

  if (indexContent.includes(header)) {
    return indexContent.replace(
      new RegExp(`(${escapeRegex(header)}\\n)`),
      `$1${line}\n`,
    )
  }

  const base = indexContent.trimEnd()
  return `${base}\n\n${header}\n${line}\n`
}

function defaultToday(): string {
  return new Date().toISOString().slice(0, 10)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
