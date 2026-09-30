import { describe, expect, it, vi, beforeEach } from "vitest";
import { CursorApiError, isCursorApiError } from "./errors.js";
import {
  assertCursorInferenceConfig,
  createHttpClient,
} from "./client.js";
import { createCursorClient } from "./cursor-client.js";
import { createCursorProvider, createComposerModel } from "./provider.js";
import {
  resolveCursorConfigFromEnv,
  resolveCursorConfigFromEnvOrThrow,
} from "./helpers.js";
import {
  COMPOSER_25,
  CURSOR_API_BASE_URL_ENV,
  CURSOR_API_KEY_ENV,
  CURSOR_STANDARD_AGENTS_V1_BASE_URL,
} from "./constants.js";

describe("assertCursorInferenceConfig", () => {
  it("throws when apiKey is missing", () => {
    expect(() =>
      assertCursorInferenceConfig({
        baseURL: "https://example.com/v1",
      }),
    ).toThrow(CursorApiError);
  });

  it("throws when baseURL is missing", () => {
    expect(() =>
      assertCursorInferenceConfig({
        apiKey: "crsr_test",
      }),
    ).toThrow(CursorApiError);
  });

  it("passes with apiKey and baseURL", () => {
    expect(() =>
      assertCursorInferenceConfig({
        apiKey: "crsr_test",
        baseURL: "https://example.com/v1",
      }),
    ).not.toThrow();
  });
});

describe("createHttpClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("adds Bearer authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ object: "list", data: [] }),
      _data: { object: "list", data: [] },
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createHttpClient({
      apiKey: "crsr_test_key",
      baseURL: "https://example.com/v1",
    });

    await client("/models");

    expect(fetchMock).toHaveBeenCalled();
    const firstArg = fetchMock.mock.calls[0]?.[0];
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;

    const authFromRequest =
      firstArg instanceof Request
        ? firstArg.headers.get("Authorization")
        : undefined;
    const authFromInit =
      init?.headers instanceof Headers
        ? init.headers.get("Authorization")
        : (init?.headers as Record<string, string> | undefined)?.Authorization;

    expect(authFromRequest ?? authFromInit).toBe("Bearer crsr_test_key");
  });

  it("maps API errors to CursorApiError", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        error: { message: "Invalid API key", code: "invalid_api_key" },
      }),
      _data: {
        error: { message: "Invalid API key", code: "invalid_api_key" },
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createHttpClient({
      apiKey: "bad",
      baseURL: "https://example.com/v1",
    });

    await expect(client("/models")).rejects.toMatchObject({
      name: "CursorApiError",
      status: 401,
    });
  });
});

describe("CursorApiError helpers", () => {
  it("detects auth and rate limit errors", () => {
    const authError = new CursorApiError("auth", 401, "UNAUTHORIZED");
    const rateError = new CursorApiError("rate", 429, "RATE_LIMITED");

    expect(authError.isAuthError()).toBe(true);
    expect(rateError.isRateLimitError()).toBe(true);
    expect(rateError.isRetryable()).toBe(true);
    expect(isCursorApiError(authError)).toBe(true);
  });
});

describe("createCursorClient", () => {
  it("exposes chat, responses, and models resources", () => {
    const client = createCursorClient({
      apiKey: "crsr_test",
      baseURL: CURSOR_STANDARD_AGENTS_V1_BASE_URL,
    });

    expect(client.chat).toBeDefined();
    expect(client.responses).toBeDefined();
    expect(client.models).toBeDefined();
  });
});

describe("createCursorProvider", () => {
  it("returns a provider with chatModel", () => {
    const provider = createCursorProvider({
      apiKey: "crsr_test",
      baseURL: CURSOR_STANDARD_AGENTS_V1_BASE_URL,
    });

    const model = provider.chatModel(COMPOSER_25);
    expect(model).toBeDefined();
    expect(model.provider).toMatch(/^cursor/);
  });

  it("createComposerModel returns a language model", () => {
    const model = createComposerModel({
      apiKey: "crsr_test",
      baseURL: CURSOR_STANDARD_AGENTS_V1_BASE_URL,
    });

    expect(model.provider).toMatch(/^cursor/);
  });
});

describe("resolveCursorConfigFromEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when env vars are missing", () => {
    delete process.env[CURSOR_API_KEY_ENV];
    delete process.env[CURSOR_API_BASE_URL_ENV];
    expect(resolveCursorConfigFromEnv()).toBeNull();
  });

  it("returns config when env vars are set", () => {
    process.env[CURSOR_API_KEY_ENV] = "crsr_test";
    process.env[CURSOR_API_BASE_URL_ENV] = CURSOR_STANDARD_AGENTS_V1_BASE_URL;

    expect(resolveCursorConfigFromEnv()).toEqual({
      apiKey: "crsr_test",
      baseURL: CURSOR_STANDARD_AGENTS_V1_BASE_URL,
      timeout: 60_000,
      retry: 2,
    });
  });

  it("throws from resolveCursorConfigFromEnvOrThrow when incomplete", () => {
    delete process.env[CURSOR_API_BASE_URL_ENV];
    process.env[CURSOR_API_KEY_ENV] = "crsr_test";

    expect(() => resolveCursorConfigFromEnvOrThrow()).toThrow(
      /CURSOR_API_BASE_URL/,
    );
  });
});
