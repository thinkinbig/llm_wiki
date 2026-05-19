# Ingest run stage order and page references

**Status:** accepted

Domain terms live in [`CONTEXT.md`](../../CONTEXT.md). This ADR records ordering invariants and link semantics that are easy to break during refactors.

## Context

An **Ingest run** turns one **source** into many wiki **pages**. The LLM only approximates the **entity manifest**; deterministic **follow-up passes** fill gaps. Several production bugs came from treating this pipeline as a linear script instead of a dependency graph: catch-up ran before stub **pages** existed, post-link ran on a stale path list, and the knowledge graph ignored **Related** while ingest wrote most **page references** there.

## Decisions

### 1. Ingest run stage order is invariant

When batched entity generation applies, stages run in this order only:

```text
analysis
  → primary entity batches
  → Manifest coverage
  → Catch-up
  → Link pass
  → Global generation
```

**Invariants:**

- **Manifest coverage** before **Catch-up** — catch-up targets missing files or **stub pages** on disk; stubs are created by manifest coverage.
- **Catch-up** before **Link pass** — link pass must see final entity/concept content (or stubs that will not be link-normalized as final).
- **Link pass** before **Global generation** — link pass operates on entity/concept paths from this run; global generation writes structural pages (index, log, overview, source summary) afterward.
- After all write stages that touch entity/concept paths, recompute the path set passed to **Link pass** from everything written this run (batches, stubs, catch-up) — do not freeze the list before catch-up.

**Manual save** is not an **Ingest run** and does not inherit this DAG.

### 2. One concept: page reference

A **page reference** (target **page id**) may be expressed as **Related** or **Wikilink**. Readers (knowledge graph, navigation) and writers (ingest, link pass) must use the same resolution rules for both — not separate “graph links” vs “frontmatter links.”

### 3. Reference resolution policy (hybrid)

- **Link pass** (and equivalent normalization): rewrite shorthand targets to canonical **page id** when exactly one page matches (e.g. unique suffix: `spark` → `apache-spark`).
- If ambiguous or missing: leave **unresolved**, queue a **Review** where appropriate; do not invent edges or navigation targets.
- **Knowledge graph**: draw edges only for **resolved page references**; count both **Related** and body **wikilinks** as sources of references.

## Considered options

**Catch-up before Manifest coverage** — rejected. Catch-up cannot replace stubs that do not exist yet; manifest entries stay missing or half-written.

**Link pass after Global generation** — rejected. Structural pages are out of scope for the entity/concept path list; moving link pass later drops normalization on the bulk of references written during batched ingest.

**Strict page-id-only references (no heuristic resolution)** — rejected for ingest. LLMs routinely emit shorthand; unique-match rewrite during **Link pass** reduces false “broken link” UI without guessing when ambiguous.

**Separate domain types for Related vs Wikilink** — rejected. Split readers/writers recreated the “0 links in graph but related: populated” failure mode.

## Consequences

- Refactors that reorder `runBatchedEntityGeneration` or `autoIngestImpl` must preserve the DAG above; regression tests should assert disk state between stages (stub present before catch-up, path list after catch-up).
- New features that add post-processing must declare where they sit relative to **Global generation** and whether they need the full entity/concept path set.
- Implementation modules (`post-ingest-materialize.ts`, `post-ingest-wikilinks.ts`, `wiki-graph.ts`, `wiki-page-resolver.ts`) are adapters; behavior changes that violate this ADR need an ADR revision, not silent drift.
