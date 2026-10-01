import type { HttpClient } from "../client"
import type { AddTensionRequest, ResolveTensionRequest, Tension, TensionStatus } from "../types"

/**
 * Knowledge tensions: two claims that cannot both be true.
 *
 * A tension is worth more than either claim alone, so it is pinned into every
 * context build with an actionable question until it is resolved.
 */
export class TensionsResource {
  constructor(private readonly client: HttpClient) {}

  async list(status?: TensionStatus): Promise<Tension[]> {
    const response = await this.client<{ tensions: Tension[] }>("/tensions", {
      method: "GET",
      query: status === undefined ? {} : { status }
    })
    return response.tensions
  }

  async create(request: AddTensionRequest): Promise<Tension> {
    const response = await this.client<{ tension: Tension }>("/tensions", {
      method: "POST",
      body: request
    })
    return response.tension
  }

  async resolve(id: string, request: ResolveTensionRequest): Promise<Tension> {
    const response = await this.client<{ tension: Tension }>(`/tensions/${encodeURIComponent(id)}`, {
      method: "POST",
      body: request
    })
    return response.tension
  }
}
