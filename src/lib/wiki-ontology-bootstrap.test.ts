/**
 * Integration tests for ontology bootstrap + page registry using real fs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { bootstrapOntology, ensureWikiGovernance } from "./wiki-ontology-bootstrap"
import { loadOntology, resolveOntology } from "./wiki-ontology"
import { loadPageRegistry } from "./page-registry"

vi.mock("@/commands/fs", () => realFs)

let tmp: { path: string; cleanup: () => Promise<void> }

beforeEach(async () => {
  tmp = await createTempProject("gov")
  await fs.mkdir(`${tmp.path}/wiki/entities`, { recursive: true })
  await writeFileRaw(
    `${tmp.path}/schema.md`,
    "# Wiki Schema — Research Deep-Dive\n\n## Page Types\n",
  )
})

afterEach(async () => {
  await tmp.cleanup()
})

describe("wiki-ontology-bootstrap", () => {
  it("creates ontology.json from schema.md header", async () => {
    const ontology = await bootstrapOntology(tmp.path)
    expect(ontology.templateId).toBe("research")
    expect(ontology.validationMode).toBe("strict")
    const loaded = await loadOntology(tmp.path)
    expect(loaded?.templateId).toBe("research")
  })

  it("ensureWikiGovernance rebuilds page registry from wiki files", async () => {
    await writeFileRaw(
      `${tmp.path}/wiki/entities/spark.md`,
      "---\ntype: entity\ntitle: Spark\ncreated: 2026-05-21\n---\n\n# Spark\n",
    )
    const resolved = await ensureWikiGovernance(tmp.path)
    expect(resolved.pageTypes.entity).toBeDefined()
    const registry = await loadPageRegistry(tmp.path)
    expect(registry?.pages["entities/spark"]).toMatchObject({
      type: "entity",
      title: "Spark",
    })
  })

  it("uses permissive mode and legacy types when schema header is unknown", async () => {
    await writeFileRaw(`${tmp.path}/schema.md`, "# Custom Schema\n")
    await fs.mkdir(`${tmp.path}/wiki/thesis`, { recursive: true })
    await writeFileRaw(
      `${tmp.path}/wiki/thesis/hypothesis.md`,
      "---\ntype: thesis\ntitle: Hypothesis\ncreated: 2026-05-21\n---\n\n# H\n",
    )
    const ontology = await bootstrapOntology(tmp.path)
    expect(ontology.templateId).toBe("general")
    expect(ontology.validationMode).toBe("permissive")
    expect(ontology.pageTypes.thesis?.legacy).toBe(true)
    const resolved = resolveOntology(ontology)
    expect(resolved.pageTypes.thesis?.directory).toBe("wiki/thesis")
  })
})
