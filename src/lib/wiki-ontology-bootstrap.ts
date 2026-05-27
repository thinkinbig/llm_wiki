/**
 * Lazy bootstrap for wiki ontology + page registry — ADR 0006.
 */

import { readFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { normalizePath } from "@/lib/path-utils"
import { rebuildPageRegistry, wikiLinkTargetFromRelPath } from "@/lib/page-registry"
import {
  flattenWikiMdFiles,
} from "@/lib/wiki-catalog"
import { listDirectory } from "@/commands/fs"
import {
  buildOntologyForTemplate,
  loadOntology,
  resolveOntology,
  saveOntology,
  SCHEMA_HEADER_TO_TEMPLATE,
  type PageTypeDef,
  type ResolvedOntology,
  type WikiOntology,
} from "@/lib/wiki-ontology"
import { legacyPageTypeFromObservation } from "@/lib/wiki-ontology-validation"

const STRUCTURAL_FILENAMES = new Set(["index.md", "log.md", "overview.md"])

async function inferTemplateFromSchema(projectPath: string): Promise<string | null> {
  try {
    const raw = await readFile(`${normalizePath(projectPath)}/schema.md`)
    const firstLine = raw.split("\n")[0]?.trim() ?? ""
    return SCHEMA_HEADER_TO_TEMPLATE[firstLine] ?? null
  } catch {
    return null
  }
}

async function scanLegacyPageTypeAdditions(
  projectPath: string,
  resolved: ResolvedOntology,
): Promise<Record<string, PageTypeDef>> {
  const pp = normalizePath(projectPath)
  const wikiRoot = `${pp}/wiki`
  let tree
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return {}
  }

  const additions: Record<string, PageTypeDef> = {}

  for (const file of flattenWikiMdFiles(tree)) {
    if (STRUCTURAL_FILENAMES.has(file.name)) continue
    const relPath = normalizePath(file.path.slice(pp.length + 1))
    const wikiRel = wikiLinkTargetFromRelPath(relPath)

    let pageType: string | undefined
    try {
      const raw = await readFile(file.path)
      const { frontmatter } = parseFrontmatter(raw)
      if (frontmatter?.type && typeof frontmatter.type === "string") {
        pageType = frontmatter.type.trim().toLowerCase()
      }
    } catch {
      continue
    }
    if (!pageType || resolved.pageTypes[pageType] || additions[pageType]) continue

    const { type, def } = legacyPageTypeFromObservation(pageType, wikiRel)
    additions[type] = def
  }

  return additions
}

export async function bootstrapOntology(projectPath: string): Promise<WikiOntology> {
  const pp = normalizePath(projectPath)

  const inferred = await inferTemplateFromSchema(pp)
  const templateId = inferred ?? "general"
  const validationMode = inferred ? "strict" : "permissive"

  let ontology = buildOntologyForTemplate(templateId, validationMode)

  const resolved = resolveOntology(ontology)
  const legacy = await scanLegacyPageTypeAdditions(pp, resolved)
  if (Object.keys(legacy).length > 0) {
    ontology = {
      ...ontology,
      pageTypes: { ...ontology.pageTypes, ...legacy },
    }
  }

  await saveOntology(pp, ontology)
  return ontology
}

/**
 * Ensure ontology + page registry exist. Rebuilds registry every call
 * (cheap for typical wiki sizes; called on project open).
 */
export async function ensureWikiGovernance(
  projectPath: string,
): Promise<ResolvedOntology> {
  const pp = normalizePath(projectPath)
  let ontology = await loadOntology(pp)
  if (!ontology) {
    ontology = await bootstrapOntology(pp)
  }

  const resolved = resolveOntology(ontology)
  await rebuildPageRegistry(pp, resolved)
  return resolved
}

/**
 * After external file changes: rebuild registry and return paths that
 * changed under wiki/ (for optional validation pass).
 */
export async function reconcileWikiGovernanceAfterExternalChanges(
  projectPath: string,
  relativePaths: string[],
): Promise<void> {
  const wikiPaths = relativePaths.filter(
    (p) => p.startsWith("wiki/") && p.endsWith(".md"),
  )
  if (wikiPaths.length === 0) return

  const resolved = await ensureWikiGovernance(projectPath)
  // External edits: queue reviews for violations (never block).
  const { validateWikiPageWrite, queueSchemaViolationReviews } = await import(
    "@/lib/wiki-ontology-validation"
  )
  const { readFile } = await import("@/commands/fs")
  const pp = normalizePath(projectPath)

  for (const rel of wikiPaths) {
    if (STRUCTURAL_FILENAMES.has(rel.split("/").pop() ?? "")) continue
    try {
      const content = await readFile(`${pp}/${rel}`)
      const result = validateWikiPageWrite(rel, content, resolved, {
        validationMode: resolved.validationMode,
        pageExists: true,
      })
      if (result.violations.length > 0) {
        queueSchemaViolationReviews(rel, result.violations)
      }
    } catch {
      // deleted or unreadable — registry rebuild already handled removal
    }
  }
}
