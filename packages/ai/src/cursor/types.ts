import type { CursorModelId } from "./constants.js";

export type { CursorModelId };

export interface CursorInferenceConfig {
  /** Cursor API key (`crsr_...`) from Dashboard → Integrations → API Keys. */
  apiKey: string;
  /** OpenAI-compatible inference base URL — required; no silent third-party default. */
  baseURL: string;
  /** Request timeout in ms. Default: 60_000. */
  timeout?: number;
  /** Retry count for retryable errors. Default: 2. */
  retry?: number;
  /** Log request/response metadata when true. */
  debug?: boolean;
}

export type ChatCompletionRole = "system" | "user" | "assistant" | "tool";

export interface ChatCompletionMessage {
  role: ChatCompletionRole;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatCompletionToolCall[];
}

export interface ChatCompletionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatCompletionCreateParams {
  model: CursorModelId;
  messages: ChatCompletionMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: unknown[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionMessage;
  finish_reason: string | null;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: ChatCompletionUsage;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: Partial<ChatCompletionMessage>;
  finish_reason: string | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: ChatCompletionUsage;
}

export interface ResponsesCreateParams {
  model: CursorModelId;
  input: string | ChatCompletionMessage[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface ResponsesResult {
  id: string;
  object: string;
  created_at?: number;
  model: string;
  output?: unknown[];
  output_text?: string;
  usage?: ChatCompletionUsage;
  [key: string]: unknown;
}

export interface ModelObject {
  id: string;
  object: "model";
  created?: number;
  owned_by?: string;
}

export interface ModelListResponse {
  object: "list";
  data: ModelObject[];
}

export interface CursorProviderConfig extends CursorInferenceConfig {
  /** Optional provider display name for AI SDK metadata. */
  name?: string;
}
