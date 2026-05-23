import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { buildOntologyForTemplate, saveOntology } from "./wiki-ontology"
import { writeGovernedWikiPage } from "./wiki-page-write-governance"
import { loadPageRegistry } from "./page-registry"

vi.mock("@/commands/fs", () => realFs)

let tmp: { path: string; cleanup: () => Promise<void> }

beforeEach(async () => {
  tmp = await createTempProject("gov-write")
  await writeFileRaw(`${tmp.path}/schema.md`, "# Wiki Schema\n")
  const ontology = buildOntologyForTemplate("general", "strict")
  await saveOntology(tmp.path, ontology)
})

afterEach(async () => {
  await tmp.cleanup()
})

describe("writeGovernedWikiPage", () => {
  it("writes a valid concept page and updates the registry", async () => {
    const content =
      "---\ntype: concept\ntitle: Attention\ncreated: 2026-05-21\n---\n\n# Attention\n"
    const result = await writeGovernedWikiPage(
      tmp.path,
      "wiki/concepts/attention.md",
      content,
    )
    expect(result.ok).toBe(true)
    const registry = await loadPageRegistry(tmp.path)
    expect(registry?.pages["concepts/attention"]).toMatchObject({
      type: "concept",
      title: "Attention",
    })
  })

  it("blocks an unknown type in strict mode", async () => {
    const content =
      "---\ntype: unknown\ntitle: Bad\ncreated: 2026-05-21\n---\n\n# Bad\n"
    const result = await writeGovernedWikiPage(
      tmp.path,
      "wiki/concepts/bad.md",
      content,
    )
    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
  })

  it("infers type from directory when frontmatter omits it", async () => {
    const content = "---\ntitle: RoPE\ncreated: 2026-05-21\n---\n\n# RoPE\n"
    const result = await writeGovernedWikiPage(
      tmp.path,
      "wiki/concepts/rope.md",
      content,
    )
    expect(result.ok).toBe(true)
    expect(result.content).toContain("type: concept")
  })
})
