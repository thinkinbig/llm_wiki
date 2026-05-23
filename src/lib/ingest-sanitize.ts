import { parseSources, writeSources } from "@/lib/sources-merge"

/**
 * Clean up an LLM-generated wiki page body before it hits disk.
 *
 * Audit of one real corpus (67 entity pages from `/Test321/wiki/entities`)
 * showed 30/67 pages had frontmatter that couldn't be parsed strictly.
 * Three recurring shapes the model emits:
 *
 *   1. The whole page wrapped in a `\`\`\`yaml … \`\`\`` (or `\`\`\`md`,
 *      `\`\`\`markdown`) code fence, e.g.
 *
 *          ```yaml
 *          ---
 *          type: entity
 *          ---
 *          # Body
 *          ```
 *
 *      — looks fine in the generation context but has no place in a
 *      real .md file.
 *
 *   2. A leading `frontmatter:` key that turns the document into a
 *      malformed nested-yaml shape, e.g.
 *
 *          frontmatter:
 *          ---
 *          type: entity
 *          ---
 *
 *   3. Inline wikilink lists without the outer brackets, e.g.
 *
 *          related: [[a]], [[b]], [[c]]
 *
 *      — semantically what the model wanted (a list of wikilinks),
 *      but not valid YAML flow syntax.
 *
 *   4. All frontmatter keys squeezed onto one line (no `---` fences),
 *      e.g.
 *
 *          type: entity title: Foo tags: [a] related: [b] created: 2026-01-01
 *
 *      — invalid YAML; the read-time parser can't build FrontmatterPanel
 *      fields and the body may render as raw text.
 *
 *   5. `sources:` filenames with commas but no YAML quotes — the array is
 *      split into bogus fragments (`Reliable`, `Scalable`, …).
 *
 *   6. Closing `---` glued onto the last frontmatter line
 *      (`sources: ["file.pdf"]]---`).
 *
 *   7. Milkdown WYSIWYG round-trip artifacts: `\---`, escaped `\[ \]`
 *      in frontmatter, and standalone `<br />` lines in the body.
 *
 * This sanitizer rewrites all of the above into the standard
 * `---\n…\n---\n` frontmatter form before write. It's deliberately
 * conservative: each pattern is anchored at the very start of the
 * document (or at top-level frontmatter scope), so a legitimate
 * fenced code block deep in the body or a `frontmatter:` mention
 * inside prose is left alone.
 *
 * The read-time parser still retains its fallback paths so old,
 * already-written corrupt files render correctly. Sanitizing on
 * write means newly-generated files never need that fallback,
 * which means re-ingesting an old file once cleans it up
 * permanently. Manual editor saves skip this (preserve user spacing).
 */
export function sanitizeIngestedFileContent(content: string): string {
  let cleaned = content

  // Pre-pass: structural artifacts that must be resolved before frontmatter parsing.
  cleaned = repairMilkdownArtifacts(cleaned)
  cleaned = stripConcatenatedFileMarkers(cleaned)
  cleaned = stripSpuriousHorizontalRules(cleaned)
  cleaned = repairYamlFrontmatterFence(cleaned)
  cleaned = repairGluedClosingFence(cleaned)
  cleaned = repairGluedOpeningFence(cleaned)
  cleaned = ensureClosingFrontmatterFence(cleaned)

  // Unwrap outer code fence or leading `frontmatter:` key.
  cleaned = stripOuterCodeFence(cleaned)
  cleaned = stripFrontmatterKeyPrefix(cleaned)

  // Normalize fenceless single-line frontmatter into a `---` block.
  cleaned = repairInlineFrontmatter(cleaned)

  // Repair invalid YAML inside frontmatter: wikilink lists and nested brackets.
  // Body wikilinks are left alone — they render fine via read-time transform.
  cleaned = repairWikilinkListsInFrontmatter(cleaned)
  cleaned = repairNestedWikilinksInFrontmatter(cleaned)

  // Coalesce comma-split `sources:` fragments and re-quote entries.
  cleaned = repairSourcesInContent(cleaned)

  // Remove stray `---` line left between frontmatter and body after fenceless repair.
  cleaned = stripDuplicateFenceAfterFrontmatter(cleaned)

  return cleaned
}

// ---------------------------------------------------------------------------
// Pre-pass repairs
// ---------------------------------------------------------------------------

/** Escaped `---` lines, `\[ \]` brackets, and standalone `<br />` rows (Milkdown). */
function repairMilkdownArtifacts(content: string): string {
  let c = content.replace(/\\([\[\]])/g, "$1")
  c = c.replace(/^\\---\s*$/gm, "---")
  c = c.replace(/^\s*<br\s*\/?>\s*$/gim, "")
  c = c.replace(/\n{4,}/g, "\n\n\n")
  return c
}

/** Drop `---FILE: wiki/...---` tails (batch ingest wrote multiple pages into one file). */
function stripConcatenatedFileMarkers(content: string): string {
  const m = content.match(/\r?\n---FILE:\s*[^\r\n]+\r?\n/)
  if (!m || m.index === undefined) return content
  return content.slice(0, m.index).replace(/\s*$/, "\n")
}

function stripSpuriousHorizontalRules(content: string): string {
  let c = content.replace(/^(?:\s*\*{3}\s*\r?\n)+/, "")
  c = c.replace(/^(?:\s*-{10,}\s*\r?\n)+/m, "")
  c = c.replace(/(?:\r?\n\s*\*{3}\s*)+$/, "\n")
  c = c.replace(/^\s*\*{3}\s*$/gm, "")
  return c
}

/** `---yaml`, `---yaml---` → standard `---` opener. */
function repairYamlFrontmatterFence(content: string): string {
  const lines = content.split(/\r?\n/)
  const first = lines[0] ?? ""
  if (!first.match(/^---ya?ml(?:---)?\s*$/i)) return content
  lines[0] = "---"
  return lines.join("\n")
}

/** `sources: ["x.pdf"]]---` → value line + `---` on its own line. */
function repairGluedClosingFence(content: string): string {
  let c = content.replace(
    /^(\s*sources\s*:\s*\[[^\]]*\])\s*\]+\s*---\s*$/gim,
    "$1\n---",
  )
  c = c.replace(
    /^(\s*(?:type|title|tags|related|sources|created|updated|description|origin|summary|status)\s*:\s*.+?)---\s*$/gim,
    "$1\n---",
  )
  return c
}

/**
 * `--- type: entity` (no newline after opening fence) → standard block opener.
 * Many ingest pages use this shape; downstream frontmatter repairs require `---\n`.
 */
function repairGluedOpeningFence(content: string): string {
  if (/^---\s*\r?\n/.test(content)) return content
  const lines = content.split(/\r?\n/)
  const first = lines[0] ?? ""
  const spaced = first.match(/^---\s+(.+)$/)
  if (spaced) {
    lines[0] = "---"
    lines.splice(1, 0, spaced[1])
    return lines.join("\n")
  }
  // `---type: entity` (no space after opener)
  const tight = first.match(
    /^---((?:type|title|tags|related|sources|created|updated|description|origin|summary|status)\s*:.*)$/i,
  )
  if (!tight) return content
  lines[0] = "---"
  lines.splice(1, 0, tight[1])
  return lines.join("\n")
}

const FM_SCALAR_KEY_RE =
  /^\s*(?:type|title|tags|related|sources|created|updated|description|origin|summary|status)\s*:/i

/**
 * Ingest stubs often end after `sources:` with no closing `---`, so
 * frontmatter-scoped repairs never run.
 */
function ensureClosingFrontmatterFence(content: string): string {
  const open = content.match(/^---\s*\r?\n/)
  if (!open) return content
  const afterOpen = content.slice(open[0].length)
  if (/\r?\n---\s*(\r?\n|$)/.test(afterOpen)) return content

  const lines = afterOpen.split(/\r?\n/)
  let fmLineCount = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === "") {
      fmLineCount++
      continue
    }
    if (FM_SCALAR_KEY_RE.test(line)) {
      fmLineCount++
      continue
    }
    break
  }
  if (fmLineCount === 0) return content

  const fmLines = lines.slice(0, fmLineCount)
  const rest = lines.slice(fmLineCount).join("\n")
  const fmBlock = fmLines.join("\n").replace(/\n$/, "")
  const suffix = rest.length > 0 ? `\n${rest}` : "\n"
  return `${open[0]}${fmBlock}\n---${suffix}`
}

// ---------------------------------------------------------------------------
// Fence / key-prefix unwrapping
// ---------------------------------------------------------------------------

/** Top-level fence wrapper. Removes the open + close fence lines. */
function stripOuterCodeFence(content: string): string {
  const open = content.match(/^[ \t]*```(?:yaml|md|markdown)?[ \t]*\r?\n/)
  if (!open) return content
  const afterOpen = content.slice(open[0].length)

  // Closing fence: a final ``` on its own line, ignoring trailing
  // whitespace/newlines after it.
  const close = afterOpen.match(/\r?\n[ \t]*```[ \t]*\r?\n?\s*$/)
  if (!close) return content
  return afterOpen.slice(0, close.index)
}

/**
 * Strip a leading `frontmatter:` line followed by the real
 * frontmatter block. Only acts when the next non-empty line is
 * `---`, so a body that legitimately mentions the word
 * "frontmatter:" in prose is unaffected.
 */
function stripFrontmatterKeyPrefix(content: string): string {
  const m = content.match(/^[ \t]*frontmatter\s*:\s*\r?\n(?=[ \t]*---\s*\r?\n)/)
  if (!m) return content
  return content.slice(m[0].length)
}

// ---------------------------------------------------------------------------
// Inline (fenceless) frontmatter repair
// ---------------------------------------------------------------------------

/** Keys the ingest pipeline may emit — used to split inline frontmatter. */
const INLINE_FM_KEYS = [
  "type",
  "title",
  "tags",
  "related",
  "created",
  "updated",
  "sources",
  "description",
  "origin",
  "summary",
  "status",
] as const

const INLINE_FM_KEY_RE = new RegExp(
  `\\b(${INLINE_FM_KEYS.join("|")})\\s*:`,
  "gi",
)

function countInlineFmKeys(line: string): number {
  return [...line.matchAll(INLINE_FM_KEY_RE)].length
}

/**
 * Rewrite fenceless, space-separated frontmatter (usually one long line
 * starting with `type:`) into a standard `---` block. Requires at least
 * two recognized keys on the opening line(s) so prose that mentions
 * "type:" mid-sentence is left alone.
 */
function repairInlineFrontmatter(content: string): string {
  if (/^---\s*\r?\n/.test(content)) return content

  const lines = content.split(/\r?\n/)
  const firstLine = lines[0] ?? ""
  if (!/^\s*type\s*:/i.test(firstLine)) return content

  let fmLineCount = 1
  while (fmLineCount < lines.length) {
    const line = lines[fmLineCount]
    if (/^\s*---\s*$/.test(line)) break
    if (line.trim() === "" || /^\s*#/.test(line)) break
    if (countInlineFmKeys(line) >= 2) {
      fmLineCount++
      continue
    }
    if (
      /^\s*(?:type|title|tags|related|created|updated|sources|description|origin)\s*:/i.test(
        line,
      )
    ) {
      fmLineCount++
      continue
    }
    break
  }

  if (fmLineCount < 2 && countInlineFmKeys(firstLine) < 2) return content

  const fmText = lines.slice(0, fmLineCount).join("\n")
  const yamlLines = splitInlineFrontmatterToLines(fmText)
  if (yamlLines.length < 2) return content

  let bodyStart = fmLineCount
  while (bodyStart < lines.length && lines[bodyStart].trim() === "") {
    bodyStart++
  }
  if (/^\s*---\s*$/.test(lines[bodyStart] ?? "")) {
    bodyStart++
    while (bodyStart < lines.length && lines[bodyStart].trim() === "") {
      bodyStart++
    }
  }
  const body = lines.slice(bodyStart).join("\n")

  const fmBlock = `---\n${yamlLines.join("\n")}\n---\n`
  if (!body) return fmBlock.endsWith("\n") ? fmBlock : `${fmBlock}\n`
  return `${fmBlock}\n${body}`
}

function splitInlineFrontmatterToLines(text: string): string[] {
  const out: string[] = []
  for (const line of text.split("\n")) {
    const matches = [...line.matchAll(INLINE_FM_KEY_RE)]
    for (let i = 0; i < matches.length; i++) {
      const key = matches[i][1].toLowerCase()
      const valueStart = matches[i].index! + matches[i][0].length
      const valueEnd = i + 1 < matches.length ? matches[i + 1].index! : line.length
      const value = line.slice(valueStart, valueEnd).trim()
      out.push(`${key}: ${value}`)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Frontmatter wikilink repairs
// ---------------------------------------------------------------------------

const FM_BLOCK_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/gm

function mapAllFrontmatterBlocks(
  content: string,
  repairPayload: (payload: string) => string,
): string {
  return content.replace(FM_BLOCK_RE, (full, payload: string, lineEnding: string) => {
    const repaired = repairPayload(payload)
    if (repaired === payload) return full
    return `---\n${repaired}\n---${lineEnding}`
  })
}

function repairWikilinkListsInFrontmatter(content: string): string {
  return mapAllFrontmatterBlocks(content, (payload) =>
    payload
      .split("\n")
      .map((line) => {
        const lm = line.match(
          /^(\s*[A-Za-z_][\w-]*\s*:\s*)(\[\[[^\]]+\]\](?:\s*,\s*\[\[[^\]]+\]\])+)\s*$/,
        )
        if (!lm) return line
        const items = lm[2]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => `"${s}"`)
          .join(", ")
        return `${lm[1]}[${items}]`
      })
      .join("\n"),
  )
}

/** `[[[slug]]]` in related/tags; `[[…]]` inside quoted sources. */
function repairNestedWikilinksInFrontmatter(content: string): string {
  return mapAllFrontmatterBlocks(content, (payload) =>
    payload
      .split("\n")
      .map((line) => {
        if (/^\s*sources\s*:/i.test(line)) {
          let s = line
          if (s.includes("[[")) {
            s = s.replace(
              /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
              (_, _slug: string, label?: string) => (label ?? _slug).trim(),
            )
          }
          s = s.replace(/^(\s*sources\s*:.*?"[^"]*")(\]+)(\s*)$/, "$1]$3")
          return s
        }

        const titleM = line.match(
          /^(\s*(?:title|description|summary|origin)\s*:\s*)(.+)$/i,
        )
        if (titleM && titleM[2].includes("[[")) {
          let raw = titleM[2].trim()
          const quoted = raw.match(/^"(.*)"$/)
          if (quoted) raw = quoted[1]
          const plain = unwrapWikilinkScalar(raw)
          return `${titleM[1]}${quoteYamlScalarIfNeeded(plain)}`
        }

        const am = line.match(/^(\s*(?:related|tags)\s*:\s*)(.+)$/)
        if (!am || !am[2].includes("[[")) return line
        const raw = am[2]
        // `[[a]], [[b]]` → repairWikilinkListsInFrontmatter; single `[[a]]` left alone.
        if (/^\[.*"\[\[/.test(raw) || /^\s*\[\[[^\]]+\]\]\s*$/.test(raw)) {
          return line
        }
        if (!raw.includes("[[[") && !/,\s*\[\[/.test(raw)) return line

        const items = parseMixedWikilinkArrayValue(raw)
        if (items.length === 0) return line

        const yamlItems = items
          .map((item) =>
            item.includes(" ") || item.includes(",") ? `"${item}"` : item,
          )
          .join(", ")
        return `${am[1]}[${yamlItems}]`
      })
      .join("\n"),
  )
}

/** `[[slug|Label]]` or `[[slug]]` → display text (label if piped). */
function unwrapWikilinkScalar(text: string): string {
  return text
    .trim()
    .replace(
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_, _slug: string, label?: string) => (label ?? _slug).trim(),
    )
}

/** `[[[a]], [[b]], bare-slug` → slug list for YAML arrays. */
function parseMixedWikilinkArrayValue(value: string): string[] {
  const items: string[] = []
  for (const m of value.matchAll(/\[\[+([^\]]+)\]\]+/g)) {
    const item = m[1].trim()
    if (item && !items.includes(item)) items.push(item)
  }
  const rest = value.replace(/\[\[+[^\]]+\]\]+/g, "")
  for (const part of rest.split(",")) {
    const item = part.replace(/^[\s\[\]]+|[\s\[\]]+$/g, "").trim()
    if (item && !items.includes(item)) items.push(item)
  }
  return items
}

function quoteYamlScalarIfNeeded(value: string): string {
  if (/[:#,\[\]{}&*!|>'"%@`/\s]/.test(value) || value === "") {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  }
  return value
}

// ---------------------------------------------------------------------------
// Sources coalescing
// ---------------------------------------------------------------------------

/**
 * Drop `sources` entries that are comma-split fragments of a longer filename
 * already present (or reconstructable by rejoining with ", ").
 */
export function coalesceFragmentedSources(sources: string[]): string[] {
  const trimmed = sources.map((s) => s.trim()).filter(Boolean)
  if (trimmed.length <= 1) return trimmed

  const afterSubstringDrop = trimmed.filter((s, i) => {
    const low = s.toLowerCase()
    return !trimmed.some(
      (t, j) => j !== i && t.length > s.length && t.toLowerCase().includes(low),
    )
  })

  if (afterSubstringDrop.length <= 1) return afterSubstringDrop

  const longest = [...afterSubstringDrop].sort((a, b) => b.length - a.length)[0]!
  const joinedAll = trimmed.join(", ")
  if (
    trimmed.length >= 2 &&
    /\.(pdf|md|markdown|txt|docx?|html?|epub)$/i.test(longest) &&
    joinedAll.length >= longest.length * 0.9
  ) {
    return [longest]
  }

  const reconstructed = trimmed.join(", ")
  if (
    trimmed.length >= 2 &&
    /\.(pdf|md|markdown|txt|docx?|html?|epub)$/i.test(reconstructed) &&
    reconstructed.length > Math.max(...trimmed.map((s) => s.length))
  ) {
    return [reconstructed]
  }

  return afterSubstringDrop
}

function repairSourcesInContent(content: string): string {
  if (!/^---\s*\r?\n/.test(content)) return content
  const sources = parseSources(content)
  if (sources.length === 0) return content
  const coalesced = coalesceFragmentedSources(sources)
  if (
    coalesced.length === sources.length &&
    coalesced.every((s, i) => s === sources[i])
  ) {
    return content
  }
  return writeSources(content, coalesced)
}

// ---------------------------------------------------------------------------
// Post-pass cleanup
// ---------------------------------------------------------------------------

/** `---\n…\n---\n---\nBody` → single closing fence before body. */
function stripDuplicateFenceAfterFrontmatter(content: string): string {
  return content.replace(
    /(^---\s*\r?\n[\s\S]*?\r?\n---)[ \t]*\r?\n[ \t]*---[ \t]*\r?\n/gm,
    "$1\n",
  )
}
