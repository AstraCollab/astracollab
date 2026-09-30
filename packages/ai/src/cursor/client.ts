import { ofetch, type $Fetch } from "ofetch";
import {
  CursorApiError,
  mapStatusToCode,
} from "./errors.js";
import {
  DEFAULT_CURSOR_RETRY,
  DEFAULT_CURSOR_TIMEOUT_MS,
} from "./constants.js";
import type { CursorInferenceConfig } from "./types.js";

export type HttpClient = $Fetch;

export interface HttpClientConfig extends CursorInferenceConfig {}

const normalizeBaseUrl = (baseURL: string): string =>
  baseURL.replace(/\/+$/, "");

export function assertCursorInferenceConfig(
  config: Partial<CursorInferenceConfig>,
): asserts config is CursorInferenceConfig {
  if (!config.apiKey?.trim()) {
    throw new CursorApiError(
      "Cursor apiKey is required",
      400,
      "INVALID_CONFIG",
    );
  }
  if (!config.baseURL?.trim()) {
    throw new CursorApiError(
      "Cursor baseURL is required — set an OpenAI-compatible inference endpoint explicitly",
      400,
      "INVALID_CONFIG",
    );
  }
}

export const createHttpClient = (config: HttpClientConfig): HttpClient => {
  assertCursorInferenceConfig(config);

  const baseURL = normalizeBaseUrl(config.baseURL);

  return ofetch.create({
    baseURL,
    timeout: config.timeout ?? DEFAULT_CURSOR_TIMEOUT_MS,
    retry: config.retry ?? DEFAULT_CURSOR_RETRY,
    retryStatusCodes: [408, 425, 429, 500, 502, 503, 504],
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    onRequest: ({ request, options }) => {
      if (config.debug) {
        // eslint-disable-next-line no-console
        console.debug(
          "[@astracollab/ai/cursor]",
          options.method ?? "GET",
          request,
        );
      }
    },
    onResponse: ({ request, response, options }) => {
      if (config.debug) {
        // eslint-disable-next-line no-console
        console.debug(
          "[@astracollab/ai/cursor]",
          response.status,
          options.method ?? "GET",
          request,
        );
      }
    },
    onResponseError: ({ response }) => {
      const data = response._data as
        | {
            error?: { message?: string; code?: string; type?: string };
            message?: string;
            code?: string;
          }
        | undefined;

      const message =
        data?.error?.message ??
        data?.message ??
        response.statusText ??
        "Request failed";
      const code =
        data?.error?.code ??
        data?.code ??
        mapStatusToCode(response.status);

      throw new CursorApiError(message, response.status, code, {
        ...(typeof data?.error === "object" ? data.error : {}),
      });
    },
  });
};
