import { createHttpClient, type HttpClient } from "./client"
import { ContextResource } from "./resources/context"
import { MemoriesResource } from "./resources/memories"
import { RecallResource } from "./resources/recall"
import { SelfModelResource } from "./resources/self-model"
import { StatsResource } from "./resources/stats"
import { TensionsResource } from "./resources/tensions"
import { TurnsResource } from "./resources/turns"
import type { Health, CognitiveMemoryConfig } from "./types"
import { fetchHealth } from "./resources/stats"

/**
 * The client.
 *
 * Named `Cogmem` rather than `CognitiveMemory` because that name belongs to the
 * in-process engine, and has for as long as this layer existed. Two exports
 * cannot share a name, and the engine's is the older public API: quietly
 * redefining it to mean an HTTP client would break every consumer of it.
 *
 * Resource classes rather than a flat list of functions, because
 * `memory.memories.` in an editor shows every operation on memories and nothing
 * else. The methods stay one-to-one with endpoints, so the class never becomes a
 * second, divergent copy of the service.
 *
 * `readonly` on the resources is not decoration: it stops a caller reassigning
 * `memory.memories` and wondering why the other half of the client stopped
 * seeing the change.
 */
export class Cogmem {
  private readonly client: HttpClient
  readonly baseUrl: string

  readonly memories: MemoriesResource
  readonly context: ContextResource
  readonly recall: RecallResource
  readonly turns: TurnsResource
  readonly tensions: TensionsResource
  readonly selfModel: SelfModelResource
  readonly stats: StatsResource

  constructor(config: CognitiveMemoryConfig) {
    this.baseUrl = (config.baseUrl ?? "http://localhost:3000").replace(/\/$/, "")
    this.client = createHttpClient(config)
    this.memories = new MemoriesResource(this.client)
    this.context = new ContextResource(this.client)
    this.recall = new RecallResource(this.client)
    this.turns = new TurnsResource(this.client)
    this.tensions = new TensionsResource(this.client)
    this.selfModel = new SelfModelResource(this.client)
    this.stats = new StatsResource(this.client)
  }

  /**
   * Liveness and limits, without spending a request on the configured key.
   *
   * Useful in a readiness probe: if `extractor` is `rules-only` the service is up
   * but is not doing model-backed extraction, and `problems` is non-empty when a
   * setting is present but unusable.
   */
  health(): Promise<Health> {
    return fetchHealth(this.baseUrl)
  }
}

/**
 * Both construction styles, deliberately.
 *
 * Some people prefer `new Cogmem(...)` and some prefer `createClient(...)`; there
 * is no reason to make anyone rename. The factory is also the easier one to mock
 * in tests, which is the whole reason `createHttpClient` is a function.
 */
export function createClient(config: CognitiveMemoryConfig): Cogmem {
  return new Cogmem(config)
}
