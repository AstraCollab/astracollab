import { createHttpClient } from "./client.js";
import {
  ChatResource,
  ModelsResource,
  ResponsesResource,
} from "./resources/index.js";
import type { CursorInferenceConfig } from "./types.js";

export class CursorClient {
  readonly chat: ChatResource;
  readonly responses: ResponsesResource;
  readonly models: ModelsResource;

  constructor(config: CursorInferenceConfig) {
    const client = createHttpClient(config);
    this.chat = new ChatResource(client);
    this.responses = new ResponsesResource(client);
    this.models = new ModelsResource(client);
  }
}

export const createCursorClient = (
  config: CursorInferenceConfig,
): CursorClient => new CursorClient(config);
