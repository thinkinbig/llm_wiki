/**
 * Normalize a path to use forward slashes (works on both macOS and Windows).
 * Windows APIs accept forward slashes, so normalizing to / is safe everywhere.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/")
}

/**
 * Join path segments with forward slashes.
 */
export function joinPath(...segments: string[]): string {
  return segments
    .map((s) => s.replace(/\\/g, "/"))
    .join("/")
    .replace(/\/+/g, "/")
}

/**
 * Get the filename from a path (handles both / and \).
 */
export function getFileName(p: string): string {
  const normalized = p.replace(/\\/g, "/")
  return normalized.split("/").pop() ?? p
}

/**
 * Get the file stem (filename without extension).
 */
export function getFileStem(p: string): string {
  const name = getFileName(p)
  const lastDot = name.lastIndexOf(".")
  return lastDot > 0 ? name.slice(0, lastDot) : name
}

/**
 * Get relative path from base.
 */
export function getRelativePath(fullPath: string, basePath: string): string {
  const normalFull = normalizePath(fullPath)
  const normalBase = normalizePath(basePath).replace(/\/$/, "")
  if (normalFull.startsWith(normalBase + "/")) {
    return normalFull.slice(normalBase.length + 1)
  }
  return normalFull
}

/**
 * Canonical LanceDB / vector `page_id` for a wiki markdown file.
 * Folder-qualified (e.g. `entities/ntp`), matching wikilink targets.
 */
export function wikiPageIdFromPath(pagePath: string): string {
  const normalized = normalizePath(pagePath)
  const wikiMarker = "/wiki/"
  const idx = normalized.indexOf(wikiMarker)
  let rel: string
  if (idx >= 0) {
    rel = normalized.slice(idx + wikiMarker.length)
  } else if (normalized.startsWith("wiki/")) {
    rel = normalized.slice("wiki/".length)
  } else {
    rel = normalized
  }
  return rel.replace(/\.md$/i, "")
}

/**
 * Cross-platform absolute-path detection.
 *
 * Unix:     "/foo/bar"
 * Windows:  "C:\foo", "C:/foo", "\\server\share", "//server/share"
 *
 * A bare `.startsWith("/")` check wrongly treats Windows paths like
 * "C:/project/file.pdf" as relative, which produced double-joined
 * garbage like "C:/project/C:/project/file.pdf" in the ingest queue.
 */
export function isAbsolutePath(p: string): boolean {
  if (!p) return false
  if (p.startsWith("/")) return true
  if (/^[A-Za-z]:[\\/]/.test(p)) return true
  if (p.startsWith("\\\\") || p.startsWith("//")) return true
  return false
}
