import { describe, it, expect } from "vitest"
import { auditWikiPages, pageFromAuditDetail } from "./wiki-audit"

describe("auditWikiPages", () => {
  it("flags stub marker and broken wikilink", async () => {
    const pages = [
      {
        rel: "concepts/foo.md",
        slug: "foo",
        dir: "concepts" as const,
        content: `---
title: Foo
---
# Foo

See [[missing-target]].
`,
        title: "Foo",
      },
    ]
    const findings = await auditWikiPages(pages, "/wiki", {
      readFile: async () => {
        throw new Error("missing")
      },
    })
    expect(findings["WIKI-LINK-BROKEN-NONEXISTENT"]?.length).toBe(1)
    expect(findings["WIKI-INDEX-STALE"]?.length).toBeGreaterThan(0)
  })

  it("detects unfilled stub pages", async () => {
    const pages = [
      {
        rel: "entities/bar.md",
        slug: "bar",
        dir: "entities" as const,
        content: `---
title: Bar
---
_Stub page — batched ingest did not emit this file_
`,
        title: "Bar",
      },
    ]
    const findings = await auditWikiPages(pages, "/wiki", {
      readFile: async () => "",
    })
    expect(findings["WIKI-STUB-UNFILLED"]?.map((f) => f.detail)).toContain(
      "entities/bar.md",
    )
  })
})

describe("pageFromAuditDetail", () => {
  it("extracts relative page path", () => {
    expect(pageFromAuditDetail('concepts/foo.md → [[bar]]')).toBe("concepts/foo.md")
    expect(pageFromAuditDetail("wiki/index.md missing")).toBe("index.md")
  })
})

describe("WIKI-TITLE-SLUG-MISMATCH", () => {
  it("does not flag when pageId hyphenation differs but dedupKey matches (2PC)", async () => {
    const pages = [
      {
        rel: "concepts/acid-and-distributed-transactions-xa-2pc.md",
        slug: "acid-and-distributed-transactions-xa-2pc",
        dir: "concepts" as const,
        content: `---
title: ACID and distributed transactions (XA, 2PC)
---
# ACID

Body.
`,
        title: "ACID and distributed transactions (XA, 2PC)",
      },
    ]
    const findings = await auditWikiPages(pages, "/wiki", {
      readFile: async () => "",
    })
    expect(findings["WIKI-TITLE-SLUG-MISMATCH"] ?? []).toHaveLength(0)
  })
})
