import { describe, expect, it } from "vitest"
import {
  appendIndexEntry,
  appendWikiLogContent,
  formatIndexEntry,
  formatLogEntry,
  isCanonicalWikiLogPath,
  normalizeLogAppendContent,
  WIKI_LOG_PATH,
} from "./wiki-structural"

describe("formatLogEntry", () => {
  it("emits Karpathy-style grep-friendly headers", () => {
    expect(formatLogEntry("ingest", "paper.pdf", { date: "2026-05-21" })).toBe(
      "## [2026-05-21] ingest | paper.pdf",
    )
  })

  it("escapes pipe in subject", () => {
    expect(formatLogEntry("delete", "a | b", { date: "2026-01-01" })).toBe(
      "## [2026-01-01] delete | a / b",
    )
  })
})

describe("normalizeLogAppendContent", () => {
  it("passes through canonical headers", () => {
    const raw = "## [2026-05-21] ingest | foo.pdf\n\nDetails here."
    expect(normalizeLogAppendContent(raw, { action: "ingest", subject: "x" })).toBe(raw)
  })

  it("upgrades legacy ## YYYY-MM-DD headers", () => {
    const out = normalizeLogAppendContent("## 2026-05-20\n\n- did something", {
      action: "ingest",
      subject: "fallback.pdf",
    })
    expect(out).toContain("## [2026-05-20] ingest | fallback.pdf")
    expect(out).toContain("did something")
  })

  it("upgrades legacy bullet lines", () => {
    const out = normalizeLogAppendContent(
      "- 2026-05-19: Saved query page `queries/foo.md`",
      { action: "save", subject: "queries/foo.md" },
    )
    expect(out).toMatch(/^## \[2026-05-19\] save \| Saved query page/)
  })

  it("wraps freeform prose when no header matches", () => {
    const out = normalizeLogAppendContent("Ingest finished.", {
      action: "ingest",
      subject: "doc.pdf",
      date: "2026-05-21",
    })
    expect(out).toBe("## [2026-05-21] ingest | doc.pdf\n\nIngest finished.")
  })
})

describe("appendWikiLogContent", () => {
  it("appends with blank line separator", () => {
    expect(appendWikiLogContent("# Log\n\n## [2026-05-20] ingest | a", "## [2026-05-21] ingest | b")).toBe(
      "# Log\n\n## [2026-05-20] ingest | a\n\n## [2026-05-21] ingest | b\n",
    )
  })
})

describe("index helpers", () => {
  it("formats listing lines", () => {
    expect(formatIndexEntry("entities/foo", "A widget")).toBe(
      "- [[entities/foo]] — A widget",
    )
    expect(formatIndexEntry("entities/foo", "desc", { displayTitle: "Foo" })).toBe(
      "- [[entities/foo|Foo]] — desc",
    )
  })

  it("inserts a new line immediately under an existing section header", () => {
    const index = "# Wiki Index\n\n## Entities\n- [[a]] — old\n"
    const out = appendIndexEntry(index, "Entities", "- [[b]] — new")
    expect(out).toContain("## Entities\n- [[b]] — new\n- [[a]] — old\n")
  })

  it("creates a missing section", () => {
    const out = appendIndexEntry("# Wiki Index\n", "Queries", "- [[q]] — question")
    expect(out).toContain("## Queries\n- [[q]] — question")
  })
})

describe("canonical paths", () => {
  it("only wiki/log.md is the structural log", () => {
    expect(isCanonicalWikiLogPath(WIKI_LOG_PATH)).toBe(true)
    expect(isCanonicalWikiLogPath("wiki/archived/log.md")).toBe(false)
  })
})
