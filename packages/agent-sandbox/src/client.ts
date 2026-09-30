import { ofetch, type $Fetch, type FetchOptions } from "ofetch";
import { SandboxApiError } from "./errors.js";

export interface HttpClientConfig {
  baseURL: string;
  /** Header name + value pairs; merged into every request. */
  headers?: Record<string, string>;
  /** Bearer token shortcut — set as `Authorization: Bearer <token>`. */
  token?: string;
  /** Request timeout in ms. */
  timeout?: number;
  /** Number of retries on retryable errors (5xx / RATE_LIMITED). Default: 2. */
  retry?: number;
  /** Enables verbose logging of requests/responses. */
  debug?: boolean;
}

/**
 * Factory for ofetch-based HTTP clients used by provider packages.
 *
 * Picked over axios for its tiny footprint (~5KB vs ~30KB) and clean
 * interceptor model that maps naturally onto our error shape. Returning
 * the raw `$Fetch` keeps every method one HTTP call deep — no business
 * logic hides in the transport.
 */
export const createHttpClient = (config: HttpClientConfig): $Fetch => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(config.headers ?? {}),
  };
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }

  return ofetch.create({
    baseURL: config.baseURL,
    headers,
    timeout: config.timeout,
    retry: config.retry ?? 2,
    retryStatusCodes: [408, 425, 429, 500, 502, 503, 504],
    onRequest: ({ request, options }) => {
      if (config.debug) {
        // eslint-disable-next-line no-console
        console.debug("[agent-sandbox] →", options.method ?? "GET", request);
      }
    },
    onResponse: ({ request, response, options }) => {
      if (config.debug) {
        // eslint-disable-next-line no-console
        console.debug(
          "[agent-sandbox] ←",
          options.method ?? "GET",
          request,
          response.status,
        );
      }
    },
    onResponseError: ({ response }) => {
      const status = response.status;
      const data = response._data as
        | { code?: string; message?: string; error?: string }
        | undefined;
      const code =
        data?.code ??
        (status === 401
          ? "UNAUTHORIZED"
          : status === 402
            ? "QUOTA_EXCEEDED"
            : status === 404
              ? "NOT_FOUND"
              : status === 408
                ? "TIMEOUT"
                : status === 429
                  ? "RATE_LIMITED"
                  : status >= 500
                    ? "SERVER_ERROR"
                    : "BAD_REQUEST");
      const message =
        data?.message ?? data?.error ?? response.statusText ?? "Request failed";
      throw new SandboxApiError(message, status, code, {
        responseBody: data,
      });
    },
  });
};

export type HttpRequestInit = FetchOptions;
