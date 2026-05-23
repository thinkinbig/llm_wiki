/**
 * Scan a wiki project against eval/wiki-defect-patterns.jsonl detectors.
 *
 * Usage:
 *   npx vite-node eval/audit-wiki-defects.ts <project-path>
 *
 * Example:
 *   npx vite-node eval/audit-wiki-defects.ts ~/wiki/ddia
 */

import { readFile, readdir } from "fs/promises"
import path from "path"
import {
  auditWikiPages,
  loadWikiAuditPages,
  resolveWikiRoot,
  WIKI_AUDIT_UNDETECTED,
  type WikiAuditFinding,
  type WikiAuditFs,
} from "@/lib/wiki-audit"

interface PatternRecord {
  id: string
  category: string
  pattern: string
  severity: string
  occurrences: number
}

export interface AuditReport {
  projectPath: string
  wikiRoot: string
  pageCount: number
  findings: Record<string, WikiAuditFinding[]>
  summary: Array<{
    id: string
    category: string
    severity: string
    baseline: number
    now: number
    status: "ok" | "warn" | "fail"
  }>
}

const nodeFs: WikiAuditFs = {
  readdir: (dir) => readdir(dir),
  readFile: (file) => readFile(file, "utf-8"),
}

async function loadPatterns(): Promise<PatternRecord[]> {
  const p = path.join(import.meta.dirname, "wiki-defect-patterns.jsonl")
  const raw = await readFile(p, "utf-8")
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PatternRecord)
}

export async function auditWikiProject(projectPath: string): Promise<AuditReport> {
  const pp = path.resolve(projectPath)
  const wikiRoot = await resolveWikiRoot(pp, nodeFs)
  const patterns = await loadPatterns()
  const pages = await loadWikiAuditPages(wikiRoot, nodeFs)
  const findings = await auditWikiPages(pages, wikiRoot, nodeFs)

  for (const id of WIKI_AUDIT_UNDETECTED) {
    if (!findings[id]) findings[id] = []
  }

  const summary = patterns.map((p) => {
    const now = findings[p.id]?.length ?? 0
    const baseline = p.occurrences
    let status: "ok" | "warn" | "fail" = "ok"
    if (now > 0 && now >= baseline * 0.5) status = "fail"
    else if (now > 0) status = "warn"
    return {
      id: p.id,
      category: p.category,
      severity: p.severity,
      baseline,
      now,
      status,
    }
  })

  return { projectPath: pp, wikiRoot, pageCount: pages.length, findings, summary }
}

function printReport(report: AuditReport & { wikiRoot?: string }): void {
  console.log(`\nWiki defect audit — ${report.projectPath}`)
  if (report.wikiRoot && report.wikiRoot !== report.projectPath) {
    console.log(`Wiki root: ${report.wikiRoot}`)
  }
  console.log(`Pages scanned: ${report.pageCount}\n`)
  console.log(
    `${"ID".padEnd(42)} ${"baseline".padStart(8)} ${"now".padStart(6)}  status`,
  )
  console.log("-".repeat(70))
  for (const row of report.summary) {
    const icon = row.status === "ok" ? "✓" : row.status === "warn" ? "~" : "✗"
    console.log(
      `${row.id.padEnd(42)} ${String(row.baseline).padStart(8)} ${String(row.now).padStart(6)}  ${icon} ${row.status}`,
    )
  }

  const failing = report.summary.filter((r) => r.now > 0)
  if (failing.length === 0) {
    console.log("\nNo automated findings.")
    return
  }

  console.log("\nSamples (first 3 per pattern):\n")
  for (const row of failing) {
    const samples = report.findings[row.id]?.slice(0, 3) ?? []
    if (samples.length === 0) continue
    console.log(`## ${row.id} (${row.now})`)
    for (const s of samples) console.log(`  - ${s.detail}`)
    if (row.now > 3) console.log(`  … +${row.now - 3} more`)
    console.log()
  }
}

const projectArg = process.argv[2]
if (projectArg) {
  const report = await auditWikiProject(projectArg)
  printReport(report)
  const anyFail = report.summary.some((r) => r.now > 0)
  process.exit(anyFail ? 1 : 0)
}
