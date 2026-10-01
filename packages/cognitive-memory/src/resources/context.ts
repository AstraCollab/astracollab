import type { HttpClient } from "../client"
import type { ContextReport, ContextRequest } from "../types"

/**
 * The prompt block.
 *
 * One call per turn, and the reason the service exists: a one-line index of
 * everything remembered, plus full bodies only where a named identifier, an
 * unresolved contradiction, or a weak domain earned them.
 */
export class ContextResource {
  constructor(private readonly client: HttpClient) {}

  build(request: ContextRequest = {}): Promise<ContextReport> {
    return this.client<ContextReport>("/context", { method: "POST", body: request })
  }
}
