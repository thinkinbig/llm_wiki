/**
 * Write-time ontology validation — ADR 0006.
 */

import { parseFrontmatter, serializeWikiPage } from "@/lib/frontmatter"
import type { FrontmatterValue } from "@/lib/frontmatter"
import { normalizePath } from "@/lib/path-utils"
import type { ValidationMode, ResolvedOntology, PageTypeDef } from "@/lib/wiki-ontology"
import {
  directoryForWikiRel,
  pageTypeForDirectory,
  STRUCTURAL_ONTOLOGY,
} from "@/lib/wiki-ontology"
import type { ReviewItem } from "@/stores/review-store"
import { useReviewStore } from "@/stores/review-store"
import { wikiLinkTargetFromRelPath } from "@/lib/page-registry"

export interface SchemaViolation {
  severity: "hard" | "soft"
  code: string
  message: string
}

export interface ValidateWikiPageOptions {
  validationMode: ValidationMode
  /** True when the target path already exists on disk (permissive mode). */
  pageExists: boolean
}

export interface ValidateWikiPageResult {
  violations: SchemaViolation[]
  /** Content after Tier C deterministic frontmatter fixes. */
  content: string
  blocked: boolean
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function isStructuralWikiPath(relativePath: string): boolean {
  const normalized = normalizePath(relativePath)
  return Object.values(STRUCTURAL_ONTOLOGY).some((s) => s.path === normalized)
}

function inferTypeFromDirectory(
  frontmatter: Record<string, FrontmatterValue>,
  wikiRel: string,
  pageTypes: Record<string, PageTypeDef>,
): Record<string, FrontmatterValue> {
  if (frontmatterString(frontmatter.type)) return frontmatter
  const dir = directoryForWikiRel(wikiRel)
  if (!dir) return frontmatter
  const inferred = pageTypeForDirectory(dir, pageTypes)
  if (!inferred) return frontmatter
  return { ...frontmatter, type: inferred }
}

function applyDeterministicFrontmatterFixes(
  frontmatter: Record<string, FrontmatterValue>,
): Record<string, FrontmatterValue> {
  const next = { ...frontmatter }
  const today = todayIsoDate()
  if (!next.created || String(next.created).trim() === "") {
    next.created = today
  }
  if (!next.updated || String(next.updated).trim() === "") {
    next.updated = today
  }
  return next
}

function frontmatterString(value: FrontmatterValue | undefined): string {
  if (value === undefined) return ""
  if (Array.isArray(value)) return value.join(",")
  return String(value).trim()
}

function validateOptionalEnums(
  frontmatter: Record<string, FrontmatterValue>,
  optional: Record<string, { enum: string[] }> | undefined,
): SchemaViolation[] {
  if (!optional) return []
  const violations: SchemaViolation[] = []
  for (const [field, spec] of Object.entries(optional)) {
    const raw = frontmatterString(frontmatter[field])
    if (!raw) continue
    if (!spec.enum.includes(raw)) {
      violations.push({
        severity: "soft",
        code: "invalid-enum",
        message: `Field "${field}" value "${raw}" is not one of: ${spec.enum.join(", ")}`,
      })
    }
  }
  return violations
}

/**
 * Validate a wiki page write against the resolved ontology.
 * Applies Tier C frontmatter stamps before checking required fields.
 */
export function validateWikiPageWrite(
  relativePath: string,
  content: string,
  ontology: ResolvedOntology,
  options: ValidateWikiPageOptions,
): ValidateWikiPageResult {
  const normalizedPath = normalizePath(relativePath)
  const violations: SchemaViolation[] = []

  if (isStructuralWikiPath(normalizedPath)) {
    const allowed = Object.values(ontology.structural).map((s) => s.path)
    if (!allowed.includes(normalizedPath)) {
      violations.push({
        severity: "hard",
        code: "structural-path",
        message: `Structural page must use a canonical path (${allowed.join(", ")})`,
      })
    }
    return finalizeResult(content, violations, options)
  }

  if (!normalizedPath.startsWith("wiki/") || !normalizedPath.endsWith(".md")) {
    return { violations: [], content, blocked: false }
  }

  const parsed = parseFrontmatter(content)
  if (!parsed.frontmatter) {
    violations.push({
      severity: "hard",
      code: "missing-frontmatter",
      message: "Wiki content page requires parseable YAML frontmatter",
    })
    return finalizeResult(content, violations, options)
  }

  const wikiRel = wikiLinkTargetFromRelPath(normalizedPath)
  const frontmatter = inferTypeFromDirectory(
    applyDeterministicFrontmatterFixes(parsed.frontmatter),
    wikiRel,
    ontology.pageTypes,
  )
  const fixedContent = serializeWikiPage(frontmatter, parsed.body)

  const pageType = frontmatterString(frontmatter.type).toLowerCase()
  const typeDef = ontology.pageTypes[pageType]

  if (!pageType || !typeDef) {
    violations.push({
      severity: "hard",
      code: "unknown-type",
      message: pageType
        ? `Unknown page type "${pageType}" for this project's ontology`
        : "Missing frontmatter type",
    })
    return finalizeResult(fixedContent, violations, options)
  }

  for (const field of typeDef.required) {
    const val = frontmatterString(frontmatter[field])
    if (!val) {
      violations.push({
        severity: "hard",
        code: "missing-required",
        message: `Missing required frontmatter field "${field}"`,
      })
    }
  }

  const observedDir = directoryForWikiRel(wikiRel)
  const expectedDir = typeDef.directory.replace(/\/+$/, "")
  if (observedDir && observedDir !== expectedDir) {
    violations.push({
      severity: "hard",
      code: "type-directory-mismatch",
      message: `Type "${pageType}" expects directory "${expectedDir}/" but path is "${normalizedPath}"`,
    })
  }

  violations.push(...validateOptionalEnums(frontmatter, typeDef.optional))

  return finalizeResult(fixedContent, violations, options)
}

function finalizeResult(
  content: string,
  violations: SchemaViolation[],
  options: ValidateWikiPageOptions,
): ValidateWikiPageResult {
  const hard = violations.filter((v) => v.severity === "hard")
  let blocked = hard.length > 0
  if (blocked && options.validationMode === "permissive" && options.pageExists) {
    // Permissive bootstrapped projects: downgrade hard → soft on existing pages.
    for (const v of hard) {
      v.severity = "soft"
    }
    blocked = false
  }
  return { violations, content, blocked }
}

export function schemaViolationsToReviewItems(
  relativePath: string,
  violations: SchemaViolation[],
  sourcePath?: string,
): Omit<ReviewItem, "id" | "resolved" | "createdAt">[] {
  if (violations.length === 0) return []
  const linkTarget = wikiLinkTargetFromRelPath(relativePath)
  const summary = violations.map((v) => v.message).join("; ")
  return [
    {
      type: "schema-violation",
      title: `Schema: ${linkTarget}`,
      description: summary,
      sourcePath,
      affectedPages: [relativePath],
      options: [{ label: "Dismiss", action: "dismiss" }],
    },
  ]
}

export function queueSchemaViolationReviews(
  relativePath: string,
  violations: SchemaViolation[],
  sourcePath?: string,
): void {
  const items = schemaViolationsToReviewItems(relativePath, violations, sourcePath)
  if (items.length > 0) {
    useReviewStore.getState().addItems(items)
  }
}

/** Infer a legacy page type definition from an observed wiki page. */
export function legacyPageTypeFromObservation(
  pageType: string,
  wikiRel: string,
): { type: string; def: import("@/lib/wiki-ontology").PageTypeDef } {
  const directory = directoryForWikiRel(wikiRel) ?? "wiki/queries"
  const folder = wikiRel.split("/")[0] ?? "queries"
  const indexSection =
    folder.charAt(0).toUpperCase() + folder.slice(1).replace(/-/g, " ")
  return {
    type: pageType,
    def: {
      directory,
      indexSection,
      required: ["type", "title", "created"],
      legacy: true,
    },
  }
}
