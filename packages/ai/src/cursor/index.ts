export {
  COMPOSER_25,
  COMPOSER_25_LIMITS,
  CURSOR_API_BASE_URL_ENV,
  CURSOR_API_KEY_ENV,
  CURSOR_STANDARD_AGENTS_OPENCODE_BASE_URL,
  CURSOR_STANDARD_AGENTS_V1_BASE_URL,
  DEFAULT_CURSOR_RETRY,
  DEFAULT_CURSOR_TIMEOUT_MS,
} from "./constants.js";

export {
  CursorApiError,
  isCursorApiError,
  mapStatusToCode,
} from "./errors.js";

export {
  assertCursorInferenceConfig,
  createHttpClient,
  type HttpClient,
} from "./client.js";

export { CursorClient, createCursorClient } from "./cursor-client.js";

export {
  resolveCursorConfigFromEnv,
  resolveCursorConfigFromEnvOrThrow,
} from "./helpers.js";

export {
  createComposerModel,
  createCursorProvider,
  type CursorProvider,
} from "./provider.js";

export type {
  ChatCompletion,
  ChatCompletionChoice,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionMessage,
  ChatCompletionRole,
  ChatCompletionToolCall,
  ChatCompletionUsage,
  CursorInferenceConfig,
  CursorModelId,
  CursorProviderConfig,
  ModelListResponse,
  ModelObject,
  ResponsesCreateParams,
  ResponsesResult,
} from "./types.js";

export {
  ChatResource,
  ModelsResource,
  ResponsesResource,
} from "./resources/index.js";
