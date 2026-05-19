import { describe, it, expect, vi, beforeEach } from "vitest"
import { buildWikilinkCandidates } from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(),
}))

vi.mock("@/lib/embedding", () => ({
  searchByEmbedding: vi.fn(),
}))

import { listDirectory } from "@/commands/fs"
import { searchByEmbedding } from "@/lib/embedding"

const mockListDirectory = vi.mocked(listDirectory)
const mockSearchByEmbedding = vi.mocked(searchByEmbedding)

beforeEach(() => {
  vi.clearAllMocks()
  useWikiStore.getState().setEmbeddingConfig({
    enabled: false,
    endpoint: "",
    apiKey: "",
    model: "",
  })
})

describe("buildWikilinkCandidates", () => {
  it("merges source slugs, embedding hits, and keyword overlap (capped)", async () => {
    mockListDirectory.mockResolvedValue([
      {
        name: "entities",
        path: "/p/wiki/entities",
        is_dir: true,
        children: [
          { name: "transformer.md", path: "/p/wiki/entities/transformer.md", is_dir: false },
          { name: "bert.md", path: "/p/wiki/entities/bert.md", is_dir: false },
          { name: "unrelated.md", path: "/p/wiki/entities/unrelated.md", is_dir: false },
        ],
      },
    ] as never)

    useWikiStore.getState().setEmbeddingConfig({
      enabled: true,
      endpoint: "http://127.0.0.1/v1/embeddings",
      apiKey: "k",
      model: "test",
    })
    mockSearchByEmbedding.mockResolvedValue([{ id: "bert", score: 0.9 }] as never)

    const slugs = await buildWikilinkCandidates(
      "/p",
      [
        { name: "Activity Based Costing", type: "concept" },
        { name: "Transformer", type: "concept" },
      ],
      [{ name: "Transformer", type: "concept" }],
    )

    expect(slugs).toContain("activity-based-costing")
    expect(slugs).toContain("transformer")
    expect(slugs).toContain("bert")
    expect(slugs.length).toBeLessThanOrEqual(30)
    expect(slugs.indexOf("activity-based-costing")).toBeLessThan(slugs.indexOf("bert"))
  })

  it("returns source slugs when wiki directory is missing", async () => {
    mockListDirectory.mockRejectedValue(new Error("no wiki"))

    const slugs = await buildWikilinkCandidates(
      "/p",
      [{ name: "Foo Bar", type: "entity" }],
      [{ name: "Foo Bar", type: "entity" }],
    )

    expect(slugs).toEqual(["foo-bar"])
  })
})
