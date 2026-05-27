/**
 * Standalone chat CLI for local testing — no Tauri app required.
 * Reads wiki files directly from disk and calls any OpenAI-compatible endpoint.
 *
 * Usage:
 *   npx vite-node eval/chat-cli.ts "your question"   # single query
 *   npx vite-node eval/chat-cli.ts                   # interactive REPL
 *
 * Config (eval/.env):
 *   WIKI_PATH          path to the wiki project directory  (required)
 *   CHAT_LLM_ENDPOINT  OpenAI-compatible chat completions URL
 *                      (falls back to AZURE_ANSWER_ENDPOINT)
 *   CHAT_LLM_API_KEY   API key (falls back to AZURE_ANSWER_API_KEY)
 *   CHAT_LLM_MODEL     model name (default: gpt-4o-mini)
 */

import { readFile as fsRead, readdir, stat } from "fs/promises"
import * as path from "path"
import * as readline from "readline"

// ── Env ──────────────────────────────────────────────────────────────────────

async function loadEnv(envPath: string) {
  try {
    const raw = await fsRead(envPath, "utf-8")
    for (const line of raw.split("\n")) {
      const t = line.trim()
      if (!t || t.startsWith("#")) continue
      const eq = t.indexOf("=")
      if (eq < 0) continue
      const key = t.slice(0, eq).trim()
      const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "")
      if (!(key in process.env)) process.env[key] = val
    }
  } catch {}
}

function cfg() {
  const endpoint = process.env.CHAT_LLM_ENDPOINT ?? process.env.AZURE_ANSWER_ENDPOINT ?? ""
  const apiKey   = process.env.CHAT_LLM_API_KEY  ?? process.env.AZURE_ANSWER_API_KEY   ?? ""
  const model    = process.env.CHAT_LLM_MODEL ?? "gpt-4o-mini"
  const wikiPath = process.env.WIKI_PATH ?? ""
  return { endpoint, apiKey, model, wikiPath }
}

// ── ANSI ──────────────────────────────────────────────────────────────────────

const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  cyan:   "\x1b[36m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  blue:   "\x1b[34m",
}

// ── Tokenization (mirrors src/lib/search.ts tokenizeQuery) ───────────────────

const STOP = new Set([
  "的","是","了","什么","在","有","和","与","对","从",
  "the","is","a","an","what","how","are","was","were",
  "do","does","did","be","been","being","have","has","had",
  "it","its","in","on","at","to","for","of","with","by",
  "this","that","these","those",
])

function tokenize(query: string): string[] {
  const raw = query.toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))

  const out: string[] = []
  for (const token of raw) {
    // Same ranges as src/lib/search.ts tokenizeQuery (\u escapes — not literal 一-鿿)
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(token) && token.length > 2) {
      const chars = [...token]
      for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1])
      for (const ch of chars) if (!STOP.has(ch)) out.push(ch)
    }
    out.push(token)
  }
  return [...new Set(out)]
}

// ── Wiki search (pure Node, no Rust backend needed) ──────────────────────────

interface PageHit {
  path: string
  title: string
  content: string
  score: number
}

async function findMdFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) out.push(...await findMdFiles(full))
      else if (e.name.endsWith(".md")) out.push(full)
    }
  } catch {}
  return out
}

function extractTitle(content: string, filePath: string): string {
  const m = content.match(/^#\s+(.+)/m)
  if (m) return m[1].trim()
  return path.basename(filePath, ".md")
}

function scoreDoc(tokens: string[], title: string, content: string): number {
  const lt = title.toLowerCase()
  const lc = content.toLowerCase()
  let score = 0
  for (const tok of tokens) {
    score += (lt.match(new RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length * 5
    score += Math.min(
      (lc.match(new RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length,
      10
    )
  }
  return score
}

async function searchWiki(wikiPath: string, query: string, topK = 8): Promise<PageHit[]> {
  const tokens = tokenize(query)
  const wikiDir = path.join(wikiPath, "wiki")
  const files = await findMdFiles(wikiDir)

  const hits: PageHit[] = []
  for (const f of files) {
    const content = await fsRead(f, "utf-8").catch(() => "")
    const title = extractTitle(content, f)
    const score = scoreDoc(tokens, title, content)
    if (score > 0) hits.push({ path: f, title, content, score })
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, topK)
}

// ── Prompt building ───────────────────────────────────────────────────────────

function buildPrompt(wikiPath: string, hits: PageHit[], purpose: string, index: string): string {
  const MAX_PAGE = 12_000

  const pages = hits.map((h, i) => {
    const rel = path.relative(wikiPath, h.path)
    const body = h.content.length > MAX_PAGE
      ? h.content.slice(0, MAX_PAGE) + "\n\n[...truncated...]"
      : h.content
    return `### [${i + 1}] ${h.title}\nPath: ${rel}\n\n${body}`
  }).join("\n\n---\n\n")

  return [
    "You are a knowledgeable wiki assistant. Answer questions based on the wiki content provided below.",
    "",
    "## Rules",
    "- Answer based ONLY on the numbered wiki pages provided below.",
    "- If the provided pages don't contain enough information, say so honestly.",
    "- When citing information, use the page number in brackets, e.g. [1], [2].",
    "",
    "Use markdown formatting for clarity.",
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    index   ? `## Wiki Index\n${index.slice(0, 4_000)}` : "",
    hits.length > 0 ? `## Wiki Pages\n\n${pages}` : "## Wiki Pages\n\n(No relevant pages found)",
  ].filter(Boolean).join("\n")
}

// ── LLM streaming ────────────────────────────────────────────────────────────

interface Message { role: "system" | "user" | "assistant"; content: string }

async function* streamCompletion(
  endpoint: string,
  apiKey: string,
  model: string,
  messages: Message[],
): AsyncGenerator<string> {
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey,
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, stream: true }),
  })

  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "")
    throw new Error(`LLM ${resp.status}: ${text.slice(0, 200)}`)
  }

  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let buf = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue
      const data = line.slice(6).trim()
      if (data === "[DONE]") return
      try {
        const delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> })
          .choices?.[0]?.delta?.content ?? ""
        if (delta) yield delta
      } catch {}
    }
  }
}

// ── Core chat function ────────────────────────────────────────────────────────

async function chat(question: string, history: Message[]): Promise<string> {
  const { endpoint, apiKey, model, wikiPath } = cfg()

  process.stdout.write(`${C.dim}Searching wiki...${C.reset} `)
  const hits = await searchWiki(wikiPath, question)
  process.stdout.write(`${C.dim}found ${hits.length} pages${C.reset}\n`)

  const [purpose, index] = await Promise.all([
    fsRead(path.join(wikiPath, "purpose.md"), "utf-8").catch(() => ""),
    fsRead(path.join(wikiPath, "wiki", "index.md"), "utf-8").catch(() => ""),
  ])

  const system = buildPrompt(wikiPath, hits, purpose, index)

  if (hits.length > 0) {
    process.stdout.write(
      `${C.dim}Sources: ${hits.map((h, i) => `[${i + 1}] ${h.title}`).join(", ")}${C.reset}\n`
    )
  }

  process.stdout.write(`\n${C.green}${C.bold}Assistant${C.reset}\n`)

  const messages: Message[] = [
    { role: "system", content: system },
    ...history,
    { role: "user", content: question },
  ]

  let full = ""
  for await (const token of streamCompletion(endpoint, apiKey, model, messages)) {
    process.stdout.write(token)
    full += token
  }
  process.stdout.write("\n\n")
  return full
}

// ── REPL ──────────────────────────────────────────────────────────────────────

async function repl() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const history: Message[] = []

  console.log(`${C.cyan}${C.bold}LLM Wiki Chat${C.reset}  ${C.dim}(Ctrl+C or /quit to exit)${C.reset}`)
  console.log(`${C.dim}Wiki: ${cfg().wikiPath}  Model: ${cfg().model}${C.reset}\n`)

  const ask = () =>
    new Promise<string>((resolve) => rl.question(`${C.yellow}You${C.reset} > `, resolve))

  while (true) {
    let input: string
    try {
      input = (await ask()).trim()
    } catch {
      break // Ctrl+C / EOF
    }

    if (!input) continue
    if (input === "/quit" || input === "/exit" || input === "/q") break
    if (input === "/clear") {
      history.length = 0
      console.log(`${C.dim}History cleared.${C.reset}\n`)
      continue
    }
    if (input === "/help") {
      console.log(`${C.dim}/clear  clear conversation history\n/quit   exit${C.reset}\n`)
      continue
    }

    try {
      const answer = await chat(input, history)
      history.push({ role: "user", content: input })
      history.push({ role: "assistant", content: answer })
      // Keep last 10 turns to avoid runaway context
      if (history.length > 20) history.splice(0, 2)
    } catch (err) {
      console.error(`${C.yellow}Error:${C.reset} ${err}\n`)
    }
  }

  rl.close()
  console.log(`\n${C.dim}Bye.${C.reset}`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await loadEnv(path.join(import.meta.dirname, ".env"))

  const { endpoint, apiKey, wikiPath } = cfg()
  const errors: string[] = []
  if (!endpoint)  errors.push("CHAT_LLM_ENDPOINT (or AZURE_ANSWER_ENDPOINT)")
  if (!apiKey)    errors.push("CHAT_LLM_API_KEY (or AZURE_ANSWER_API_KEY)")
  if (!wikiPath)  errors.push("WIKI_PATH")
  if (errors.length) {
    console.error(`Missing config:\n  ${errors.join("\n  ")}\nAdd them to eval/.env and retry.`)
    process.exit(1)
  }

  const question = process.argv.slice(2).join(" ").trim()
  if (question) {
    // Single-query mode
    try {
      await chat(question, [])
    } catch (err) {
      console.error(`Error: ${err}`)
      process.exit(1)
    }
  } else {
    // REPL mode
    await repl()
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
