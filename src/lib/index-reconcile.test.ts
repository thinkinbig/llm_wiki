import { describe, expect, it } from "vitest"
import {
  extractIndexLinkKeys,
  indexListsPage,
  indexSectionForWikiRel,
  reconcileWikiIndexContent,
} from "./index-reconcile"

describe("extractIndexLinkKeys", () => {
  it("collects normalized wikilink targets", () => {
    const keys = extractIndexLinkKeys(
      "## Entities\n- [[entities/foo]] — x\n- [[Bar Baz|entities/bar-baz]] — y\n",
    )
    expect(indexListsPage(keys, "entities/foo")).toBe(true)
    expect(indexListsPage(keys, "entities/bar-baz")).toBe(true)
  })
})

describe("indexSectionForWikiRel", () => {
  it("maps folders to template sections", () => {
    expect(indexSectionForWikiRel("entities/acme")).toBe("Entities")
    expect(indexSectionForWikiRel("concepts/cot")).toBe("Concepts")
  })

  it("prefers frontmatter type when present", () => {
    expect(indexSectionForWikiRel("misc/page", "source")).toBe("Sources")
  })
})

describe("reconcileWikiIndexContent", () => {
  it("adds missing pages without removing existing lines", () => {
    const index = "# Wiki Index\n\n## Entities\n- [[entities/old]] — existing\n"
    const { content, added, changed } = reconcileWikiIndexContent(index, [
      { linkTarget: "entities/old", section: "Entities", title: "Old" },
      { linkTarget: "entities/new", section: "Entities", title: "New Page" },
      { linkTarget: "concepts/idea", section: "Concepts", title: "Idea" },
    ])
    expect(changed).toBe(true)
    expect(added.map((p) => p.linkTarget)).toEqual(["concepts/idea", "entities/new"])
    expect(content).toContain("- [[entities/old]] — existing")
    expect(content).toContain("[[entities/new|New Page]]")
    expect(content).toContain("## Concepts")
  })

  it("is a no-op when index already lists every page", () => {
    const index = "## Entities\n- [[entities/a]] — A\n"
    const { changed, added } = reconcileWikiIndexContent(index, [
      { linkTarget: "entities/a", section: "Entities", title: "A" },
    ])
    expect(changed).toBe(false)
    expect(added).toEqual([])
  })
})
