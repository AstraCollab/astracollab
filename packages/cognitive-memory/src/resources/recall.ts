import type { HttpClient } from "../client"
import type { RecallRequest, RecallResponse } from "../types"

/**
 * Deterministic ranked lookup.
 *
 * No model is involved, so recall quality does not change when a provider is
 * down or a different model is configured. `empty: true` is the signal to admit
 * ignorance rather than guess.
 */
export class RecallResource {
  constructor(private readonly client: HttpClient) {}

  search(request: RecallRequest): Promise<RecallResponse> {
    return this.client<RecallResponse>("/recall", { method: "POST", body: request })
  }
}
