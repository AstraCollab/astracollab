import type { HttpClient } from "../client"
import type { DomainOutcomeRequest, SelfModel } from "../types"

/**
 * The proprioceptive self-model: how reliably this agent has done in each domain.
 *
 * Nothing here is inferred. Without outcomes recorded through `record`, the
 * model stays at its priors and no guardrail ever fires — which is the most
 * common reason a self-model looks like it is not working.
 */
export class SelfModelResource {
  constructor(private readonly client: HttpClient) {}

  get(): Promise<SelfModel> {
    return this.client<SelfModel>("/self-model", { method: "GET" })
  }

  record(request: DomainOutcomeRequest): Promise<SelfModel> {
    return this.client<SelfModel>("/self-model/outcome", { method: "POST", body: request })
  }
}
