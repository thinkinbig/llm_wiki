# Wiki ontology-lite governance model

**Status:** accepted

Domain terms live in [`CONTEXT.md`](../../CONTEXT.md). See [ADR 0002](0002-page-reference-unification.md) for page reference semantics, [ADR 0003](0003-defect-ownership.md) for defect tiers and **Review** ownership, and [ADR 0001](0001-ingest-run-and-page-references.md) for structural page placement in **Global generation**.

## Context

Wiki structure rules today live in human-readable `schema.md` (seeded from scenario templates in `templates.ts`), while page types are enforced only loosely via prompts and scattered UI heuristics. There is no machine-readable contract, no **page registry**, and no write-time validation against a single source of truth. Type definitions drift across `templates.ts`, `wiki-structural.ts`, and `wiki-type-style.ts`.

This ADR records the **ontology-lite** governance model: enough structure for registry + write-time validation, without Palantir-style ontologies (typed link kinds, named actions, centralized object store).

## Decisions

### 1. Machine ontology is the canonical contract

- **Canonical:** `.llm-wiki/ontology.json`
- **Human/LLM-facing:** root `schema.md` — generated at project creation from ontology + template narrative; not overwritten on bootstrap or routine opens
- `schema.md` may contain prose (naming, cross-referencing, contradiction handling) that ontology does not encode in v1

### 2. Layered inheritance shape

A built-in app profile `base` defines the shared content types (entity, concept, source, query, comparison, synthesis) plus global required frontmatter. Scenario templates declare additions:

```json
{
  "version": 1,
  "templateId": "research",
  "extends": "base",
  "validationMode": "strict",
  "pageTypes": {
    "thesis": {
      "directory": "wiki/thesis",
      "indexSection": "Queries",
      "required": ["type", "title", "created"],
      "optional": {
        "confidence": { "enum": ["low", "medium", "high"] },
        "status": { "enum": ["speculative", "supported", "refuted", "settled"] }
      }
    }
  },
  "structural": {
    "index": { "path": "wiki/index.md", "derived": true },
    "log": { "path": "wiki/log.md", "derived": true, "appendOnly": true },
    "overview": { "path": "wiki/overview.md", "derived": false }
  }
}
```

- `overview` is **structural only** — not a regular extensible `pageTypes` entry
- Per-type optional fields with enums live in ontology; narrative field semantics stay in `schema.md` prose

### 3. Page registry (derived index, write-through cache)

- **Path:** `.llm-wiki/page-registry.json`
- **Authority:** filesystem + frontmatter remain source of truth for page existence
- **Update:** increment on app writes; full rebuild on project-open bootstrap and external file-sync events
- **Entry shape:** folder-qualified **page id** → `{ type, relPath, title, updatedAt }`
- **Excluded:** structural files (`index.md`, `log.md`, `overview.md`)

### 4. Write-time validation and violation policy

Aligns with [ADR 0003](0003-defect-ownership.md) tiers:

| Violation class | Examples | App write path | External sync |
|-----------------|----------|----------------|---------------|
| Hard contract | unknown type; type↔directory mismatch; missing required frontmatter | **Block that page write** + queue **Review** | **Review** only (never block) |
| Soft contract | invalid optional enum | **Allow write** + **Review** | **Review** only |
| Deterministic fix | stamp `created` / `updated` | Tier C silent fix | N/A |

- Block = skip **one page**, never abort an entire **Ingest run**
- v1 does **not** auto-move files to correct directories
- Schema violations use a dedicated **Review** kind (`schema-violation`) — separate from **unresolved page reference** (`missing-page`) Reviews per [ADR 0004](0004-remove-stub-pages.md)

### 5. Structural files

Declared under ontology `structural`, not in the **page registry**:

- Fixed paths; app writes to the wrong path → hard contract block
- Format contracts (log header, index sections) live in `wiki-structural.ts`; Tier C fixes where deterministic
- [ADR 0001](0001-ingest-run-and-page-references.md): index/log/overview still written by **Global generation** after **Link pass**

### 6. Legacy project bootstrap

On project open, if `.llm-wiki/ontology.json` is missing:

1. Infer `templateId` from `schema.md` H1 (e.g. `Wiki Schema — Research Deep-Dive` → `research`)
2. On match failure: `extends: base`, `templateId: general`, `validationMode: permissive`
3. Scan `wiki/**/*.md` frontmatter + directories; add unknown types as `legacy: true` additions (observed only — no enum guessing)
4. Build `page-registry.json` from a full filesystem scan
5. Do **not** rewrite existing `schema.md`

- **New projects** (create dialog): `validationMode: strict`
- **Bootstrapped projects**: `validationMode: permissive` — pre-existing inconsistencies → **Review**; hard contract applies to new writes after bootstrap

### 7. Page references — reaffirm ADR 0002

- v1 ontology governs **page types and frontmatter**, not link kinds
- One link concept: **page reference** (**Related** + **Wikilink**, same resolution)
- No typed relations (`depends_on`, `part_of`, …) in v1

## In scope / out of scope

**In scope (v1):**

- `.llm-wiki/ontology.json` with layered inheritance
- `.llm-wiki/page-registry.json` write-through cache
- Write-time validation at content-page write chokepoints
- Structural file path contracts
- Lazy bootstrap for legacy projects

**Out of scope (deferred):**

- Typed link kinds / relation ontology
- Named actions on types
- Centralized object store (markdown files remain truth)
- Auto file relocation on type/directory mismatch
- Reserved empty `relations` / `actions` fields in ontology JSON
- Bidirectional ontology ↔ `schema.md` sync UI

## Considered options

**`schema.md` as canonical, ontology derived by parsing tables** — rejected. Markdown tables are brittle for enforcement and drift from code-defined types.

**Authoritative page registry (registry overrides filesystem)** — rejected. Local-first + Obsidian external edits make the filesystem the durable truth.

**Palantir-style typed relations in v1** — rejected. [ADR 0002](0002-page-reference-unification.md) already unified links; adding types splits readers/writers again.

**Reserved empty `relations` / `actions` arrays in ontology JSON** — rejected. No v1 consumer; empty shells invite premature coupling.

## Consequences

- Implementation depends on extending the Tier A write chokepoint ([ADR 0003](0003-defect-ownership.md)) to call ontology validation and **page registry** update
- `templates.ts` must seed ontology at project creation, not only `schema.md`
- Filesystem catalog scans (`listWikiCatalogPages` and registry rebuild) should share one seam
- Eval fixtures may need `.llm-wiki/ontology.json` for strict-mode projects
- A future ADR is required before adding typed relations or named actions
