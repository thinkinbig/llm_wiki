/**
 * Page registry — ADR 0006. Materialized index at
 * `.llm-wiki/page-registry.json` (write-through cache over wiki pages).
 */

import { readFile, writeFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { getRelativePath, normalizePath } from "@/lib/path-utils"
import {
  flattenWikiMdFiles,
  type WikiCatalogPage,
} from "@/lib/wiki-catalog"
import type { ResolvedOntology } from "@/lib/wiki-ontology"
import { listDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"

export const REGISTRY_VERSION = 1
export const REGISTRY_REL_PATH = ".llm-wiki/page-registry.json"

const STRUCTURAL_FILENAMES = new Set(["index.md", "log.md", "overview.md"])

export interface PageRegistryEntry {
  type: string
  relPath: string
  title: string
  updatedAt: string
}

export interface PageRegistry {
  version: number
  pages: Record<string, PageRegistryEntry>
}

export function registryPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/${REGISTRY_REL_PATH}`
}

/** Wikilink target from project-relative wiki path, e.g. `entities/foo`. */
export function wikiLinkTargetFromRelPath(relPath: string): string {
  const normalized = normalizePath(relPath)
  const wikiRel = normalized.startsWith("wiki/")
    ? normalized.slice("wiki/".length)
    : normalized
  return wikiRel.replace(/\.md$/i, "")
}

export function emptyPageRegistry(): PageRegistry {
  return { version: REGISTRY_VERSION, pages: {} }
}

export async function loadPageRegistry(
  projectPath: string,
): Promise<PageRegistry | null> {
  try {
    const raw = await readFile(registryPath(projectPath))
    const parsed = JSON.parse(raw) as PageRegistry
    if (parsed?.version !== REGISTRY_VERSION || !parsed.pages) return null
    return parsed
  } catch {
    return null
  }
}

export async function savePageRegistry(
  projectPath: string,
  registry: PageRegistry,
): Promise<void> {
  await writeFile(registryPath(projectPath), JSON.stringify(registry, null, 2))
}

export function catalogPageToRegistryEntry(
  page: WikiCatalogPage,
  relPath: string,
  pageType: string,
  updatedAt: string,
): PageRegistryEntry {
  return {
    type: pageType,
    relPath: normalizePath(relPath),
    title: page.title,
    updatedAt,
  }
}

/**
 * Scan every non-structural wiki page and rebuild the registry from disk.
 */
export async function rebuildPageRegistry(
  projectPath: string,
  _ontology?: ResolvedOntology,
): Promise<PageRegistry> {
  const pp = normalizePath(projectPath)
  const wikiRoot = `${pp}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return emptyPageRegistry()
  }

  const pages: Record<string, PageRegistryEntry> = {}
  const stamp = new Date().toISOString()

  for (const file of flattenWikiMdFiles(tree)) {
    if (STRUCTURAL_FILENAMES.has(file.name)) continue
    const relPath = normalizePath(getRelativePath(file.path, pp))
    const linkTarget = wikiLinkTargetFromRelPath(relPath)
    if (!linkTarget) continue

    let title = linkTarget.split("/").pop() ?? linkTarget
    let pageType = "query"
    try {
      const raw = await readFile(file.path)
      const { frontmatter } = parseFrontmatter(raw)
      if (frontmatter?.title && typeof frontmatter.title === "string") {
        title = frontmatter.title.trim() || title
      }
      if (frontmatter?.type && typeof frontmatter.type === "string") {
        pageType = frontmatter.type.trim().toLowerCase()
      }
    } catch {
      // unreadable — still index with path-derived defaults
    }

    pages[linkTarget] = {
      type: pageType,
      relPath,
      title,
      updatedAt: stamp,
    }
  }

  const registry: PageRegistry = { version: REGISTRY_VERSION, pages }
  await savePageRegistry(pp, registry)
  return registry
}

export async function upsertPageRegistryEntry(
  projectPath: string,
  linkTarget: string,
  entry: PageRegistryEntry,
): Promise<void> {
  const registry = (await loadPageRegistry(projectPath)) ?? emptyPageRegistry()
  registry.pages[linkTarget] = entry
  await savePageRegistry(projectPath, registry)
}

export async function removePageRegistryEntry(
  projectPath: string,
  linkTarget: string,
): Promise<void> {
  const registry = await loadPageRegistry(projectPath)
  if (!registry?.pages[linkTarget]) return
  delete registry.pages[linkTarget]
  await savePageRegistry(projectPath, registry)
}
