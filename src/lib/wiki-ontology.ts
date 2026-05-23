/**
 * Wiki ontology — ADR 0006. Machine-readable page-type contract at
 * `.llm-wiki/ontology.json`. Built-in `base` profile + per-template additions.
 */

import { readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { IndexSection } from "@/lib/wiki-structural"

export const ONTOLOGY_VERSION = 1
export const ONTOLOGY_REL_PATH = ".llm-wiki/ontology.json"

export type ValidationMode = "strict" | "permissive"

export interface OntologyFieldEnum {
  enum: string[]
}

export interface PageTypeDef {
  directory: string
  indexSection: IndexSection | string
  required: string[]
  optional?: Record<string, OntologyFieldEnum>
  /** Observed during legacy bootstrap — not from a known template. */
  legacy?: boolean
}

export interface StructuralFileDef {
  path: string
  derived?: boolean
  appendOnly?: boolean
}

export interface WikiOntology {
  version: number
  templateId: string
  extends: "base"
  validationMode: ValidationMode
  pageTypes: Record<string, PageTypeDef>
  structural: Record<string, StructuralFileDef>
}

export interface ResolvedOntology {
  templateId: string
  validationMode: ValidationMode
  pageTypes: Record<string, PageTypeDef>
  structural: Record<string, StructuralFileDef>
}

export const STRUCTURAL_ONTOLOGY: Record<string, StructuralFileDef> = {
  index: { path: "wiki/index.md", derived: true },
  log: { path: "wiki/log.md", derived: true, appendOnly: true },
  overview: { path: "wiki/overview.md", derived: false },
}

const GLOBAL_REQUIRED = ["type", "title", "created"] as const

export const BASE_PAGE_TYPES: Record<string, PageTypeDef> = {
  entity: {
    directory: "wiki/entities",
    indexSection: "Entities",
    required: [...GLOBAL_REQUIRED],
  },
  concept: {
    directory: "wiki/concepts",
    indexSection: "Concepts",
    required: [...GLOBAL_REQUIRED],
  },
  source: {
    directory: "wiki/sources",
    indexSection: "Sources",
    required: [...GLOBAL_REQUIRED],
  },
  query: {
    directory: "wiki/queries",
    indexSection: "Queries",
    required: [...GLOBAL_REQUIRED],
  },
  comparison: {
    directory: "wiki/comparisons",
    indexSection: "Comparisons",
    required: [...GLOBAL_REQUIRED],
  },
  synthesis: {
    directory: "wiki/synthesis",
    indexSection: "Synthesis",
    required: [...GLOBAL_REQUIRED],
  },
}

/** Template-specific page types (merged on top of base at resolve time). */
export const TEMPLATE_PAGE_TYPE_ADDITIONS: Record<string, Record<string, PageTypeDef>> = {
  research: {
    thesis: {
      directory: "wiki/thesis",
      indexSection: "Queries",
      required: [...GLOBAL_REQUIRED],
      optional: {
        confidence: { enum: ["low", "medium", "high"] },
        status: { enum: ["speculative", "supported", "refuted", "settled"] },
      },
    },
    methodology: {
      directory: "wiki/methodology",
      indexSection: "Queries",
      required: [...GLOBAL_REQUIRED],
    },
    finding: {
      directory: "wiki/findings",
      indexSection: "Queries",
      required: [...GLOBAL_REQUIRED],
      optional: {
        confidence: { enum: ["low", "medium", "high"] },
        replicated: { enum: ["true", "false", "null"] },
      },
    },
  },
  reading: {
    character: {
      directory: "wiki/characters",
      indexSection: "Entities",
      required: [...GLOBAL_REQUIRED],
      optional: {
        role: { enum: ["protagonist", "antagonist", "supporting", "minor"] },
      },
    },
    theme: {
      directory: "wiki/themes",
      indexSection: "Concepts",
      required: [...GLOBAL_REQUIRED],
    },
    "plot-thread": {
      directory: "wiki/plot-threads",
      indexSection: "Queries",
      required: [...GLOBAL_REQUIRED],
    },
    chapter: {
      directory: "wiki/chapters",
      indexSection: "Sources",
      required: [...GLOBAL_REQUIRED],
    },
  },
  personal: {
    goal: {
      directory: "wiki/goals",
      indexSection: "Queries",
      required: [...GLOBAL_REQUIRED],
      optional: {
        status: { enum: ["active", "paused", "achieved", "abandoned"] },
      },
    },
    habit: {
      directory: "wiki/habits",
      indexSection: "Queries",
      required: [...GLOBAL_REQUIRED],
      optional: {
        frequency: { enum: ["daily", "weekly", "monthly"] },
        status: { enum: ["active", "paused", "dropped"] },
      },
    },
    reflection: {
      directory: "wiki/reflections",
      indexSection: "Synthesis",
      required: [...GLOBAL_REQUIRED],
    },
    journal: {
      directory: "wiki/journal",
      indexSection: "Queries",
      required: [...GLOBAL_REQUIRED],
    },
  },
  business: {
    meeting: {
      directory: "wiki/meetings",
      indexSection: "Queries",
      required: [...GLOBAL_REQUIRED],
    },
    decision: {
      directory: "wiki/decisions",
      indexSection: "Queries",
      required: [...GLOBAL_REQUIRED],
      optional: {
        status: { enum: ["proposed", "accepted", "deprecated", "superseded"] },
      },
    },
    project: {
      directory: "wiki/projects",
      indexSection: "Entities",
      required: [...GLOBAL_REQUIRED],
    },
    stakeholder: {
      directory: "wiki/stakeholders",
      indexSection: "Entities",
      required: [...GLOBAL_REQUIRED],
    },
  },
  general: {},
}

/** Map schema.md H1 → template id (legacy bootstrap). */
export const SCHEMA_HEADER_TO_TEMPLATE: Record<string, string> = {
  "# Wiki Schema": "general",
  "# Wiki Schema — Research Deep-Dive": "research",
  "# Wiki Schema — Reading a Book": "reading",
  "# Wiki Schema — Personal Growth": "personal",
  "# Wiki Schema — Business / Team": "business",
}

export function ontologyPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/${ONTOLOGY_REL_PATH}`
}

export function buildOntologyForTemplate(
  templateId: string,
  validationMode: ValidationMode = "strict",
): WikiOntology {
  const additions = TEMPLATE_PAGE_TYPE_ADDITIONS[templateId] ?? {}
  return {
    version: ONTOLOGY_VERSION,
    templateId,
    extends: "base",
    validationMode,
    pageTypes: { ...additions },
    structural: { ...STRUCTURAL_ONTOLOGY },
  }
}

export function resolveOntology(ontology: WikiOntology): ResolvedOntology {
  return {
    templateId: ontology.templateId,
    validationMode: ontology.validationMode,
    pageTypes: {
      ...BASE_PAGE_TYPES,
      ...ontology.pageTypes,
    },
    structural: { ...ontology.structural },
  }
}

export async function loadOntology(projectPath: string): Promise<WikiOntology | null> {
  try {
    const raw = await readFile(ontologyPath(projectPath))
    const parsed = JSON.parse(raw) as WikiOntology
    if (parsed?.version !== ONTOLOGY_VERSION || parsed.extends !== "base") {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export async function saveOntology(
  projectPath: string,
  ontology: WikiOntology,
): Promise<void> {
  await writeFile(ontologyPath(projectPath), JSON.stringify(ontology, null, 2))
}

export async function loadResolvedOntology(
  projectPath: string,
): Promise<ResolvedOntology | null> {
  const ontology = await loadOntology(projectPath)
  if (!ontology) return null
  return resolveOntology(ontology)
}

/** Infer page type directory from a wiki-relative path (without wiki/ prefix). */
export function directoryForWikiRel(wikiRel: string): string | null {
  const parts = wikiRel.split("/").filter(Boolean)
  if (parts.length < 2) return null
  return `wiki/${parts[0]}`
}

export function pageTypeForDirectory(
  directory: string,
  pageTypes: Record<string, PageTypeDef>,
): string | null {
  const normalized = directory.replace(/\/+$/, "")
  for (const [type, def] of Object.entries(pageTypes)) {
    if (def.directory.replace(/\/+$/, "") === normalized) return type
  }
  return null
}
