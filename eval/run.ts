/**
 * Eval runner for the LLM Wiki chat pipeline.
 *
 * Prerequisites:
 *   1. Fill in eval/.env (AZURE_EVAL_API_KEY, ANTHROPIC_API_KEY, LLM_WIKI_PROJECT_ID)
 *   2. Start the LLM Wiki app so the REST search API is available
 *   3. Ensure the wiki project already has the relevant documents ingested
 *
 * Usage:
 *   npx vite-node eval/run.ts [--dataset open|cbdp|all] [--limit N] [--output results.jsonl]
 */

import { readFile, writeFile } from "fs/promises"
import path from "path"
import type { EvalRecord, RunResult, JudgeScore } from "./datasets/schema.js"

// ── Env loading ──────────────────────────────────────────────────────────────

async function loadEnv(envPath: string) {
  try {
    const raw = await readFile(envPath, "utf-8")
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eqIdx = trimmed.indexOf("=")
      if (eqIdx < 0) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "")
      if (!(key in process.env)) process.env[key] = val
    }
  } catch { /* env file optional if vars are already set */ }
}

// ── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  let dataset: "open" | "cbdp" | "all" = "all"
  let limit = Infinity
  let output = path.join(import.meta.dirname, `results-${Date.now()}.jsonl`)

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dataset" && args[i + 1]) dataset = args[++i] as typeof dataset
    if (args[i] === "--limit" && args[i + 1]) limit = Number(args[++i])
    if (args[i] === "--output" && args[i + 1]) output = args[++i]
  }
  return { dataset, limit, output }
}

// ── Dataset loading ───────────────────────────────────────────────────────────

async function loadDataset(name: "open" | "cbdp"): Promise<EvalRecord[]> {
  const p = path.join(import.meta.dirname, "datasets", `${name}.jsonl`)
  const raw = await readFile(p, "utf-8")
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvalRecord)
}

// ── Wiki search via REST API ──────────────────────────────────────────────────

interface SearchHit {
  path: string
  title: string
  snippet: string
  content?: string
  score: number
}

interface SearchResponse {
  mode: string
  results: SearchHit[]
  tokenHits: number
  vectorHits: number
}

async function searchWiki(query: string): Promise<SearchHit[]> {
  const base = process.env.LLM_WIKI_API_BASE!
  const projectId = process.env.LLM_WIKI_PROJECT_ID!
  const token = process.env.LLM_WIKI_API_TOKEN || ""

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (token) headers["Authorization"] = `Bearer ${token}`

  const resp = await fetch(`${base}/api/v1/projects/${projectId}/search`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, topK: 10, includeContent: true }),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Search API ${resp.status}: ${text.slice(0, 200)}`)
  }

  const data = (await resp.json()) as SearchResponse
  return data.results
}

// ── Build context (faithful to chat-panel.tsx) ────────────────────────────────

function buildWikiContext(hits: SearchHit[]): { context: string; snippets: string } {
  const pages = hits.slice(0, 8)
  const context = pages
    .map((p, i) => `### [${i + 1}] ${p.title}\nPath: ${p.path}\n\n${p.content ?? p.snippet}`)
    .join("\n\n---\n\n")
  const snippets = pages.map((p, i) => `[${i + 1}] ${p.title}: ${p.snippet}`).join("\n")
  return { context, snippets }
}

function buildSystemPrompt(wikiContext: string): string {
  return [
    "You are a knowledgeable wiki assistant. Answer questions based on the wiki content provided below.",
    "",
    "## Rules",
    "- Answer based ONLY on the numbered wiki pages provided below.",
    "- If the provided pages don't contain enough information, say so honestly.",
    "- When citing information, use the page number in brackets, e.g. [1], [2].",
    "",
    `## Wiki Pages\n\n${wikiContext}`,
  ].join("\n")
}

function buildMcqUserMessage(record: EvalRecord): string {
  const choices = record.mcq_choices!
  return [
    record.question,
    "",
    `A) ${choices[0]}`,
    `B) ${choices[1]}`,
    `C) ${choices[2]}`,
    `D) ${choices[3]}`,
    "",
    "Reply with only the letter of the correct answer (A, B, C, or D).",
  ].join("\n")
}

// ── Azure API callers ─────────────────────────────────────────────────────────

// gpt-5-nano: standard chat completions format
async function callAnswerModel(system: string, user: string): Promise<string> {
  const endpoint = process.env.AZURE_ANSWER_ENDPOINT!
  const apiKey = process.env.AZURE_ANSWER_API_KEY!

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": apiKey },
    body: JSON.stringify({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Answer model ${resp.status}: ${text.slice(0, 300)}`)
  }
  const data = await resp.json() as { choices?: Array<{ message: { content: string } }>; error?: { message: string } }
  if (data.error) throw new Error(`Answer model error: ${data.error.message}`)
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error(`Unexpected answer model response: ${JSON.stringify(data).slice(0, 200)}`)
  return content
}

// gpt-5.4: responses API format
async function callJudgeModel(system: string, user: string): Promise<string> {
  const endpoint = process.env.AZURE_JUDGE_ENDPOINT!
  const apiKey = process.env.AZURE_JUDGE_API_KEY!
  const model = process.env.AZURE_JUDGE_MODEL!

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": apiKey },
    body: JSON.stringify({
      model,
      instructions: system,
      input: [{ role: "user", content: user }],
    }),
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Judge model ${resp.status}: ${text.slice(0, 300)}`)
  }
  const data = await resp.json() as {
    output?: Array<{ type: string; content?: Array<{ type: string; text: string }> }>
    output_text?: string
    error?: { message: string }
  }
  if (data.error) throw new Error(`Judge model error: ${data.error.message}`)
  if (data.output_text) return data.output_text
  const text = data.output?.find((o) => o.type === "message")
    ?.content?.find((c) => c.type === "output_text")?.text
  if (text) return text
  throw new Error(`Unexpected judge model response: ${JSON.stringify(data).slice(0, 200)}`)
}

// ── Azure-backed judge ────────────────────────────────────────────────────────

const JUDGE_SYSTEM = `You are a strict technical grader evaluating an AI-generated answer against a gold reference answer.

Score on two axes, each 1–5:
- correctness: Does the answer contain the key facts from the gold answer? (1=missing most facts, 5=all key facts present)
- depth: Does the answer explain the underlying reasoning, trade-offs, or mechanisms — not just surface labels? (1=superficial/buzzwords only, 5=clear causal explanation with trade-offs)

Return ONLY a JSON object with no markdown fences:
{"correctness": <1-5>, "depth": <1-5>, "rationale": "<one sentence explaining the scores>"}`

async function scoreAnswer(opts: {
  question: string
  goldAnswer: string
  judgeRubric: string
  candidateAnswer: string
}): Promise<JudgeScore> {
  const userMsg = `Question: ${opts.question}\n\nGold answer: ${opts.goldAnswer}\n\nRubric (key concepts required): ${opts.judgeRubric}\n\nAnswer to evaluate:\n${opts.candidateAnswer}`
  const raw = await callJudgeModel(JUDGE_SYSTEM, userMsg)
  let parsed: { correctness: number; depth: number; rationale: string }
  try {
    parsed = JSON.parse(raw.trim())
  } catch {
    throw new Error(`Judge returned non-JSON: ${raw}`)
  }
  const correctness = Math.min(5, Math.max(1, Math.round(parsed.correctness)))
  const depth = Math.min(5, Math.max(1, Math.round(parsed.depth)))
  return { correctness, depth, overall: (correctness + depth) / 2, rationale: parsed.rationale ?? "" }
}

function mcqScore(choice: string, correct: string): JudgeScore {
  const hit = choice.toUpperCase() === correct.toUpperCase()
  return {
    correctness: hit ? 5 : 1,
    depth: hit ? 5 : 1,
    overall: hit ? 5 : 1,
    rationale: hit ? "Correct choice selected." : `Wrong choice: got ${choice}, expected ${correct}.`,
  }
}

// ── Single record evaluation ──────────────────────────────────────────────────

async function evalRecord(record: EvalRecord): Promise<RunResult> {
  console.log(`  [${record.id}] searching wiki…`)
  let hits: SearchHit[] = []
  let wikiContextStr = "(Search unavailable)"
  try {
    hits = await searchWiki(record.question)
    const { context, snippets } = buildWikiContext(hits)
    wikiContextStr = snippets
    const systemPrompt = buildSystemPrompt(context)
    const userMessage = record.type === "mcq"
      ? buildMcqUserMessage(record)
      : record.question

    const baselineSystem = "You are a knowledgeable assistant. Answer the question based on your training knowledge."

    console.log(`  [${record.id}] calling LLM (wiki + baseline)…`)
    const [wikiAnswer, baselineAnswer] = await Promise.all([
      callAnswerModel(systemPrompt, userMessage),
      callAnswerModel(baselineSystem, userMessage),
    ])

    console.log(`  [${record.id}] judging…`)
    let wikiScore: JudgeScore
    let baselineScore: JudgeScore

    if (record.type === "mcq") {
      const correct = record.mcq_correct!
      wikiScore = mcqScore(wikiAnswer.trim().charAt(0).toUpperCase(), correct)
      baselineScore = mcqScore(baselineAnswer.trim().charAt(0).toUpperCase(), correct)
    } else {
      ;[wikiScore, baselineScore] = await Promise.all([
        scoreAnswer({
          question: record.question,
          goldAnswer: record.gold_answer,
          judgeRubric: record.judge_rubric,
          candidateAnswer: wikiAnswer,
        }),
        scoreAnswer({
          question: record.question,
          goldAnswer: record.gold_answer,
          judgeRubric: record.judge_rubric,
          candidateAnswer: baselineAnswer,
        }),
      ])
    }

    return {
      id: record.id,
      domain: record.domain,
      skill: record.skill,
      difficulty: record.difficulty,
      question: record.question,
      goldAnswer: record.gold_answer,
      wikiContext: wikiContextStr,
      wikiAnswer,
      baselineAnswer,
      wikiScore,
      baselineScore,
      deltaOverall: wikiScore.overall - baselineScore.overall,
    }
  } catch (err) {
    console.error(`  [${record.id}] ERROR: ${err}`)
    const failScore: JudgeScore = { correctness: 0, depth: 0, overall: 0, rationale: String(err) }
    return {
      id: record.id,
      domain: record.domain,
      skill: record.skill,
      difficulty: record.difficulty,
      question: record.question,
      goldAnswer: record.gold_answer,
      wikiContext: wikiContextStr,
      wikiAnswer: "ERROR",
      baselineAnswer: "ERROR",
      wikiScore: failScore,
      baselineScore: failScore,
      deltaOverall: 0,
    }
  }
}

// ── Summary table ─────────────────────────────────────────────────────────────

function printSummary(results: RunResult[]) {
  const ok = results.filter((r) => r.wikiScore.overall > 0)
  if (ok.length === 0) { console.log("\nNo successful results to summarise."); return }

  const avg = (arr: number[]) => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)
  const wikiOverall = ok.map((r) => r.wikiScore.overall)
  const baseOverall = ok.map((r) => r.baselineScore.overall)
  const deltas = ok.map((r) => r.deltaOverall)

  console.log("\n── Summary ─────────────────────────────────────────")
  console.log(`Records evaluated : ${results.length} (${ok.length} succeeded)`)
  console.log(`Wiki overall      : ${avg(wikiOverall)} / 5`)
  console.log(`Baseline overall  : ${avg(baseOverall)} / 5`)
  console.log(`Δ (wiki − base)   : ${avg(deltas)}`)
  console.log("")

  // Per-skill breakdown
  const skills = [...new Set(ok.map((r) => r.skill))]
  for (const skill of skills) {
    const group = ok.filter((r) => r.skill === skill)
    const d = group.map((r) => r.deltaOverall)
    console.log(`  ${skill.padEnd(12)} n=${group.length}  Δ=${avg(d)}`)
  }

  console.log("\n── Per-record ──────────────────────────────────────")
  console.log("id".padEnd(24) + "wiki".padStart(6) + "base".padStart(6) + "delta".padStart(7))
  for (const r of results) {
    const w = r.wikiScore.overall.toFixed(1)
    const b = r.baselineScore.overall.toFixed(1)
    const d = (r.deltaOverall >= 0 ? "+" : "") + r.deltaOverall.toFixed(1)
    console.log(r.id.padEnd(24) + w.padStart(6) + b.padStart(6) + d.padStart(7))
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await loadEnv(path.join(import.meta.dirname, ".env"))

  const required = ["AZURE_ANSWER_ENDPOINT", "AZURE_ANSWER_API_KEY", "AZURE_JUDGE_ENDPOINT", "AZURE_JUDGE_MODEL", "AZURE_JUDGE_API_KEY", "LLM_WIKI_PROJECT_ID"]
  const missing = required.filter((k) => !process.env[k])
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(", ")}\nFill in eval/.env and try again.`)
    process.exit(1)
  }

  const { dataset, limit, output } = parseArgs()
  const datasets = dataset === "all" ? ["open", "cbdp"] : [dataset]
  let records: EvalRecord[] = []
  for (const ds of datasets) {
    records.push(...await loadDataset(ds as "open" | "cbdp"))
  }
  if (limit < Infinity) records = records.slice(0, limit)

  console.log(`Running ${records.length} eval records against project "${process.env.LLM_WIKI_PROJECT_ID}"`)
  console.log(`Output → ${output}\n`)

  const results: RunResult[] = []
  for (const record of records) {
    const result = await evalRecord(record)
    results.push(result)
    await writeFile(output, results.map((r) => JSON.stringify(r)).join("\n") + "\n")
  }

  printSummary(results)
  console.log(`\nResults saved to ${output}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
