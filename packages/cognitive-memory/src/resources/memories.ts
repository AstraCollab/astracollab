import type { HttpClient } from "../client"
import type { LearnResult, ListMemoriesParams, Memory, MemoryTier, RememberRequest } from "../types"

/**
 * Reading and writing what is stored.
 *
 * Deliberately thin: one method, one endpoint, no cleverness. The class is a
 * namespace, so `memory.memories.` offers the whole surface in an editor, but it
 * is not a place for business logic. The workflow that composes these calls lives
 * in `../helpers`.
 */
export class MemoriesResource {
  constructor(private readonly client: HttpClient) {}

  /**
   * The envelope is unwrapped here rather than passed on.
   *
   * The service replies with `{ memories, stats }` so a dashboard can get both in
   * one call, but an SDK caller who asked for a list wants a list. Deciding that
   * in one place here is better than making every integration know the shape.
   */
  async list(params: ListMemoriesParams = {}): Promise<Memory[]> {
    const response = await this.client<{ memories: Memory[] }>("/memories", {
      method: "GET",
      query: params
    })
    return response.memories
  }

  async get(id: string): Promise<Memory> {
    const response = await this.client<{ memory: Memory }>(`/memories/${encodeURIComponent(id)}`, {
      method: "GET"
    })
    return response.memory
  }

  /**
   * State facts outright.
   *
   * Restatements of something already held are folded in rather than stored
   * twice, and the result says which ones were folded and into what — a write
   * that silently did nothing is indistinguishable from a bug.
   */
  create(request: RememberRequest): Promise<LearnResult> {
    return this.client<LearnResult>("/memories", { method: "POST", body: request })
  }

  /** Move a memory between tiers. L1 is pre-staged into every context build. */
  async promote(id: string, tier: MemoryTier): Promise<Memory> {
    const response = await this.client<{ memory: Memory }>(`/memories/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { tier }
    })
    return response.memory
  }

  remove(id: string): Promise<{ deleted: boolean; id: string }> {
    return this.client(`/memories/${encodeURIComponent(id)}`, { method: "DELETE" })
  }
}
