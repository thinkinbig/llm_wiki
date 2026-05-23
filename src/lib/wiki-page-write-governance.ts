/**
 * Central wiki page write governance — ADR 0006.
 * Validates against ontology, queues schema Reviews, writes, updates registry.
 */

import { fileExists, writeFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { normalizePath } from "@/lib/path-utils"
import {
  upsertPageRegistryEntry,
  wikiLinkTargetFromRelPath,
} from "@/lib/page-registry"
import { canonicalizeContentPage } from "@/lib/wiki-content-page"
import {
  loadResolvedOntology,
  resolveOntology,
  type ResolvedOntology,
} from "@/lib/wiki-ontology"
import { bootstrapOntology } from "@/lib/wiki-ontology-bootstrap"
import {
  queueSchemaViolationReviews,
  validateWikiPageWrite,
  type SchemaViolation,
} from "@/lib/wiki-ontology-validation"
import {
  isCanonicalWikiIndexPath,
  isCanonicalWikiLogPath,
  isCanonicalWikiOverviewPath,
} from "@/lib/wiki-structural"

export interface GovernedWikiWriteOptions {
  sourcePath?: string
  /** Run canonicalizeContentPage (default: true for wiki content pages). */
  canonicalize?: boolean
  /** Skip ontology validation (provenance-only or cross-ref rewrites). */
  skipValidation?: boolean
}

export interface GovernedWikiWriteResult {
  ok: boolean
  relativePath: string
  content: string
  violations: SchemaViolation[]
  blocked: boolean
}

export async function ensureResolvedOntology(
  projectPath: string,
): Promise<ResolvedOntology> {
  return (
    (await loadResolvedOntology(projectPath)) ??
    resolveOntology(await bootstrapOntology(projectPath))
  )
}

export async function registerWrittenWikiPage(
  projectPath: string,
  canonRelPath: string,
  fileContent: string,
): Promise<void> {
  const parsed = parseFrontmatter(fileContent)
  const fm = parsed.frontmatter
  if (!fm?.type) return
  const linkTarget = wikiLinkTargetFromRelPath(canonRelPath)
  const title =
    typeof fm.title === "string" && fm.title.trim()
      ? fm.title.trim()
      : (linkTarget.split("/").pop() ?? linkTarget)
  await upsertPageRegistryEntry(projectPath, linkTarget, {
    type: String(fm.type).toLowerCase(),
    relPath: normalizePath(canonRelPath),
    title,
    updatedAt: new Date().toISOString(),
  })
}

function isWikiContentPagePath(relativePath: string): boolean {
  const normalized = normalizePath(relativePath)
  if (!normalized.startsWith("wiki/") || !normalized.endsWith(".md")) return false
  if (isCanonicalWikiLogPath(normalized)) return false
  if (isCanonicalWikiIndexPath(normalized)) return false
  if (isCanonicalWikiOverviewPath(normalized)) return false
  return true
}

/**
 * Canonicalize + validate without writing. Queues schema Reviews when needed.
 */
export async function prepareGovernedWikiWrite(
  projectPath: string,
  relativePath: string,
  content: string,
  options: GovernedWikiWriteOptions = {},
): Promise<GovernedWikiWriteResult> {
  const canonicalize = options.canonicalize ?? isWikiContentPagePath(relativePath)
  let canonRelPath = normalizePath(relativePath)
  let preparedContent = content

  if (canonicalize) {
    const canonical = canonicalizeContentPage(relativePath, content)
    canonRelPath = canonical.relativePath
    preparedContent = canonical.content
    if (canonical.isContentPage && canonical.bodyEmpty) {
      return {
        ok: false,
        relativePath: canonRelPath,
        content: preparedContent,
        violations: [
          {
            severity: "hard",
            code: "empty-body",
            message: "Entity/concept page has an empty body",
          },
        ],
        blocked: true,
      }
    }
  }

  if (options.skipValidation || !isWikiContentPagePath(canonRelPath)) {
    return {
      ok: true,
      relativePath: canonRelPath,
      content: preparedContent,
      violations: [],
      blocked: false,
    }
  }

  const ontology = await ensureResolvedOntology(projectPath)
  const pageExistsOnDisk = await fileExists(`${normalizePath(projectPath)}/${canonRelPath}`)
  const validation = validateWikiPageWrite(
    canonRelPath,
    preparedContent,
    ontology,
    {
      validationMode: ontology.validationMode,
      pageExists: pageExistsOnDisk,
    },
  )

  if (validation.violations.length > 0) {
    queueSchemaViolationReviews(
      canonRelPath,
      validation.violations,
      options.sourcePath,
    )
  }

  return {
    ok: !validation.blocked,
    relativePath: canonRelPath,
    content: validation.content,
    violations: validation.violations,
    blocked: validation.blocked,
  }
}

/** Validate, write, and update the page registry. */
export async function writeGovernedWikiPage(
  projectPath: string,
  relativePath: string,
  content: string,
  options: GovernedWikiWriteOptions = {},
): Promise<GovernedWikiWriteResult> {
  const prepared = await prepareGovernedWikiWrite(
    projectPath,
    relativePath,
    content,
    options,
  )
  if (!prepared.ok || prepared.blocked) {
    return prepared
  }

  const pp = normalizePath(projectPath)
  await writeFile(`${pp}/${prepared.relativePath}`, prepared.content)
  if (isWikiContentPagePath(prepared.relativePath)) {
    await registerWrittenWikiPage(pp, prepared.relativePath, prepared.content)
  }

  return { ...prepared, ok: true }
}

/** Write without validation; still updates registry when frontmatter has type. */
export async function writeWikiPagePatch(
  projectPath: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const pp = normalizePath(projectPath)
  const rel = normalizePath(relativePath)
  await writeFile(`${pp}/${rel}`, content)
  if (isWikiContentPagePath(rel)) {
    await registerWrittenWikiPage(pp, rel, content)
  }
}
