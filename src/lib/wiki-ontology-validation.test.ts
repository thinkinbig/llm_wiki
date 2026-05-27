import { describe, it, expect } from "vitest"
import { resolveOntology, buildOntologyForTemplate } from "./wiki-ontology"
import { validateWikiPageWrite } from "./wiki-ontology-validation"

const ontology = resolveOntology(buildOntologyForTemplate("general", "strict"))

const entityPage = (_path: string, type = "entity") =>
  `---\ntype: ${type}\ntitle: Test Page\ncreated: 2026-05-21\n---\n\n# Body\n`

describe("validateWikiPageWrite", () => {
  it("passes a valid entity page in the correct directory", () => {
    const result = validateWikiPageWrite(
      "wiki/entities/apache-spark.md",
      entityPage("wiki/entities/apache-spark.md"),
      ontology,
      { validationMode: "strict", pageExists: false },
    )
    expect(result.blocked).toBe(false)
    expect(result.violations).toHaveLength(0)
    expect(result.content).toContain("created: 2026-05-21")
  })

  it("blocks unknown page type in strict mode", () => {
    const result = validateWikiPageWrite(
      "wiki/entities/foo.md",
      entityPage("wiki/entities/foo.md", "not-a-type"),
      ontology,
      { validationMode: "strict", pageExists: false },
    )
    expect(result.blocked).toBe(true)
    expect(result.violations.some((v) => v.code === "unknown-type")).toBe(true)
  })

  it("blocks type/directory mismatch", () => {
    const result = validateWikiPageWrite(
      "wiki/concepts/spark.md",
      entityPage("wiki/concepts/spark.md", "entity"),
      ontology,
      { validationMode: "strict", pageExists: false },
    )
    expect(result.blocked).toBe(true)
    expect(result.violations.some((v) => v.code === "type-directory-mismatch")).toBe(true)
  })

  it("infers type from directory when frontmatter type is omitted", () => {
    const result = validateWikiPageWrite(
      "wiki/concepts/foo.md",
      "---\ntitle: Foo\n---\n\n# Foo\n",
      ontology,
      { validationMode: "strict", pageExists: false },
    )
    expect(result.blocked).toBe(false)
    expect(result.content).toContain("type: concept")
  })

  it("stamps missing created via Tier C before validation", () => {
    const result = validateWikiPageWrite(
      "wiki/entities/foo.md",
      "---\ntype: entity\ntitle: Foo\n---\n\n# Foo\n",
      ontology,
      { validationMode: "strict", pageExists: false },
    )
    expect(result.blocked).toBe(false)
    expect(result.content).toMatch(/created: \d{4}-\d{2}-\d{2}/)
  })

  it("downgrades hard violations to soft on existing pages in permissive mode", () => {
    const result = validateWikiPageWrite(
      "wiki/concepts/spark.md",
      entityPage("wiki/concepts/spark.md", "entity"),
      { ...ontology, validationMode: "permissive" },
      { validationMode: "permissive", pageExists: true },
    )
    expect(result.blocked).toBe(false)
    expect(result.violations.every((v) => v.severity === "soft")).toBe(true)
  })

  it("reports soft violations for invalid optional enums", () => {
    const research = resolveOntology(buildOntologyForTemplate("research"))
    const result = validateWikiPageWrite(
      "wiki/thesis/scaling.md",
      "---\ntype: thesis\ntitle: Scaling\ncreated: 2026-05-21\nconfidence: very-high\n---\n\n# T\n",
      research,
      { validationMode: "strict", pageExists: false },
    )
    expect(result.blocked).toBe(false)
    expect(result.violations.some((v) => v.code === "invalid-enum")).toBe(true)
  })
})
