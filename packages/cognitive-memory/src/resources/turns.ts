import type { HttpClient } from "../client"
import type { LearnResult, TurnRequest } from "../types"

/**
 * What `/v1/turns` accepts for one field, in characters.
 *
 * The service answers 400 above this, and a rejected turn learns nothing at all
 * — so a long answer would cost the whole exchange. The clip happens here, in
 * the one place every turn goes through, because the alternative is every caller
 * remembering a limit that only the service knows.
 *
 * This matches the service's own limit. It is a backstop against a runaway
 * string, not a rationing of a normal reply: a turn that reaches it is far past
 * anything extraction reads, and the extractor windows what it does read.
 */
export const TURN_FIELD_LIMIT = 200000

const clipField = (text: string): string =>
  text.length > TURN_FIELD_LIMIT ? `${text.slice(0, TURN_FIELD_LIMIT)}…` : text

/**
 * Learning from a completed turn.
 *
 * A turn whose user message contains a question is treated as a lookup rather
 * than a lesson, so this is called after work is done, not before.
 *
 * Fields longer than {@link TURN_FIELD_LIMIT} are clipped, not sent whole. That
 * is a real loss: the tail of a very long answer is not read. It is the smaller
 * of the two losses, and the alternative — rejecting the turn — is the one that
 * keeps nothing at all.
 */
export class TurnsResource {
  constructor(private readonly client: HttpClient) {}

  learn(request: TurnRequest): Promise<LearnResult> {
    return this.client<LearnResult>("/turns", {
      method: "POST",
      body: {
        ...request,
        userMessage: clipField(request.userMessage),
        assistantResponse: clipField(request.assistantResponse)
      }
    })
  }
}
