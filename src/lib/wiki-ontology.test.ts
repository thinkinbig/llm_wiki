import { describe, it, expect } from "vitest"
import {
  BASE_PAGE_TYPES,
  buildOntologyForTemplate,
  resolveOntology,
  SCHEMA_HEADER_TO_TEMPLATE,
  TEMPLATE_PAGE_TYPE_ADDITIONS,
} from "./wiki-ontology"

describe("wiki-ontology", () => {
  it("buildOntologyForTemplate seeds structural files and template additions", () => {
    const ontology = buildOntologyForTemplate("research", "strict")
    expect(ontology.templateId).toBe("research")
    expect(ontology.validationMode).toBe("strict")
    expect(ontology.structural.index.path).toBe("wiki/index.md")
    expect(ontology.pageTypes.thesis?.directory).toBe("wiki/thesis")
  })

  it("resolveOntology merges base types with template additions", () => {
    const resolved = resolveOntology(buildOntologyForTemplate("research"))
    expect(resolved.pageTypes.entity).toEqual(BASE_PAGE_TYPES.entity)
    expect(resolved.pageTypes.thesis).toEqual(
      TEMPLATE_PAGE_TYPE_ADDITIONS.research.thesis,
    )
    expect(resolved.pageTypes.overview).toBeUndefined()
  })

  it("maps schema headers to template ids for bootstrap", () => {
    expect(SCHEMA_HEADER_TO_TEMPLATE["# Wiki Schema — Research Deep-Dive"]).toBe(
      "research",
    )
    expect(SCHEMA_HEADER_TO_TEMPLATE["# Wiki Schema"]).toBe("general")
  })
})
