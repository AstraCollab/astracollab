import type { HttpClient } from "../client"
import type { LearnResult, TurnRequest } from "../types"

/**
 * Learning from a completed turn.
 *
 * A turn whose user message contains a question is treated as a lookup rather
 * than a lesson, so this is called after work is done, not before.
 */
export class TurnsResource {
  constructor(private readonly client: HttpClient) {}

  learn(request: TurnRequest): Promise<LearnResult> {
    return this.client<LearnResult>("/turns", { method: "POST", body: request })
  }
}
