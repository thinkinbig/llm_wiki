/**
 * Deterministic repair for `wiki/index.md`: ensure every catalog page
 * under `wiki/` appears in the index (Karpathy catalog contract).
 */

import { listDirectory, readFile, writeFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { getRelativePath, normalizePath } from "@/lib/path-utils"
import { normalizeWikiRefKey } from "@/lib/wiki-cleanup"
import type { FileNode } from "@/types/wiki"
import {
  WIKI_INDEX_PATH,
  appendIndexEntry,
  formatIndexEntry,
  indexSectionForPageType,
  type IndexSection,
} from "@/lib/wiki-structural"

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g

const STRUCTURAL_FILENAMES = new Set(["index.md", "log.md", "overview.md"])

export interface WikiCatalogPage {
  /** Wikilink target relative to `wiki/`, e.g. `entities/foo`. */
  linkTarget: string
  section: IndexSection | string
  title: string
}

export interface IndexReconcileResult {
  content: string
  added: WikiCatalogPage[]
  /** True when `content` differs from the input index. */
  changed: boolean
}

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

/** Normalized keys of every wikilink target listed in the index. */
export function extractIndexLinkKeys(indexContent: string): Set<string> {
  const keys = new Set<string>()
  for (const match of indexContent.matchAll(WIKILINK_RE)) {
    const target = match[1]?.trim()
    if (!target) continue
    keys.add(normalizeWikiRefKey(target))
  }
  return keys
}

export function indexSectionForWikiRel(
  relPath: string,
  pageType?: string,
): IndexSection | string {
  if (pageType) {
    return indexSectionForPageType(pageType)
  }
  const folder = relPath.split("/")[0]?.toLowerCase() ?? ""
  switch (folder) {
    case "entities":
      return "Entities"
    case "concepts":
      return "Concepts"
    case "sources":
      return "Sources"
    case "queries":
      return "Queries"
    case "comparisons":
      return "Comparisons"
    case "synthesis":
      return "Synthesis"
    default:
      if (!folder) return "Queries"
      return folder.charAt(0).toUpperCase() + folder.slice(1)
  }
}

function pageKeysForIndex(relPath: string): string[] {
  const keys = [normalizeWikiRefKey(relPath)]
  const base = relPath.split("/").pop()
  if (base) keys.push(normalizeWikiRefKey(base))
  return keys
}

export function indexListsPage(indexKeys: Set<string>, relPath: string): boolean {
  return pageKeysForIndex(relPath).some((k) => indexKeys.has(k))
}

/**
 * Pure reconcile: add missing catalog lines; never remove or reorder
 * existing index content.
 */
export function reconcileWikiIndexContent(
  indexContent: string,
  pages: WikiCatalogPage[],
): IndexReconcileResult {
  const indexKeys = extractIndexLinkKeys(indexContent)
  const added: WikiCatalogPage[] = []
  let content = indexContent

  const sorted = [...pages].sort((a, b) => a.linkTarget.localeCompare(b.linkTarget))

  for (const page of sorted) {
    if (indexListsPage(indexKeys, page.linkTarget)) continue
    const line = formatIndexEntry(page.linkTarget, page.title, {
      displayTitle: page.title,
    })
    content = appendIndexEntry(content, page.section, line)
    for (const k of pageKeysForIndex(page.linkTarget)) {
      indexKeys.add(k)
    }
    added.push(page)
  }

  return {
    content,
    added,
    changed: added.length > 0,
  }
}

export async function listWikiCatalogPages(
  projectPath: string,
): Promise<WikiCatalogPage[]> {
  const pp = normalizePath(projectPath)
  const wikiRoot = `${pp}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return []
  }

  const pages: WikiCatalogPage[] = []
  for (const file of flattenMdFiles(tree)) {
    if (STRUCTURAL_FILENAMES.has(file.name)) continue
    const rel = getRelativePath(file.path, wikiRoot).replace(/\.md$/i, "")
    if (!rel) continue

    let title = rel.split("/").pop() ?? rel
    let pageType: string | undefined
    try {
      const raw = await readFile(file.path)
      const { frontmatter } = parseFrontmatter(raw)
      if (frontmatter?.title && typeof frontmatter.title === "string") {
        title = frontmatter.title.trim() || title
      }
      if (frontmatter?.type && typeof frontmatter.type === "string") {
        pageType = frontmatter.type
      }
    } catch {
      // unreadable — still list with path-derived title
    }

    pages.push({
      linkTarget: rel,
      section: indexSectionForWikiRel(rel, pageType),
      title,
    })
  }

  return pages
}

/**
 * Read `wiki/index.md`, add any missing catalog entries, write back when
 * changed. Returns how many lines were added.
 */
export async function reconcileWikiIndexProject(
  projectPath: string,
): Promise<{ added: number; paths: string[] }> {
  const pp = normalizePath(projectPath)
  const indexPath = `${pp}/${WIKI_INDEX_PATH}`

  let indexContent = ""
  try {
    indexContent = await readFile(indexPath)
  } catch {
    indexContent = "# Wiki Index\n"
  }

  const catalog = await listWikiCatalogPages(pp)
  const { content, added, changed } = reconcileWikiIndexContent(indexContent, catalog)

  if (!changed) {
    return { added: 0, paths: [] }
  }

  await writeFile(indexPath, content)
  const paths = added.map((p) => p.linkTarget)
  console.log(
    `[index-reconcile] Added ${added.length} missing index entr${added.length === 1 ? "y" : "ies"}:`,
    paths.join(", "),
  )
  return { added: added.length, paths }
}
