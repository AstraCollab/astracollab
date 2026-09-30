import type { HttpClient } from "../client.js";
import type {
  ChatCompletion,
  ChatCompletionCreateParams,
  ModelListResponse,
  ResponsesCreateParams,
  ResponsesResult,
} from "../types.js";

export class ChatResource {
  constructor(private readonly client: HttpClient) {}

  async create(
    params: ChatCompletionCreateParams & { stream?: false | undefined },
  ): Promise<ChatCompletion>;
  async create(
    params: ChatCompletionCreateParams & { stream: true },
  ): Promise<ReadableStream<Uint8Array>>;
  async create(
    params: ChatCompletionCreateParams,
  ): Promise<ChatCompletion | ReadableStream<Uint8Array>> {
    if (params.stream) {
      return this.client("/chat/completions", {
        method: "POST",
        body: params,
        responseType: "stream",
      }) as Promise<ReadableStream<Uint8Array>>;
    }

    return this.client<ChatCompletion>("/chat/completions", {
      method: "POST",
      body: params,
    });
  }
}

export class ResponsesResource {
  constructor(private readonly client: HttpClient) {}

  async create(
    params: ResponsesCreateParams & { stream?: false | undefined },
  ): Promise<ResponsesResult>;
  async create(
    params: ResponsesCreateParams & { stream: true },
  ): Promise<ReadableStream<Uint8Array>>;
  async create(
    params: ResponsesCreateParams,
  ): Promise<ResponsesResult | ReadableStream<Uint8Array>> {
    if (params.stream) {
      return this.client("/responses", {
        method: "POST",
        body: params,
        responseType: "stream",
      }) as Promise<ReadableStream<Uint8Array>>;
    }

    return this.client<ResponsesResult>("/responses", {
      method: "POST",
      body: params,
    });
  }
}

export class ModelsResource {
  constructor(private readonly client: HttpClient) {}

  async list(): Promise<ModelListResponse> {
    return this.client<ModelListResponse>("/models", {
      method: "GET",
    });
  }
}
