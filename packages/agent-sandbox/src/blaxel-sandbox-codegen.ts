import { createHttpClient } from "./client.js";

/**
 * Strip trailing slashes so we can safely join OpenAPI paths.
 */
export const normalizeBlaxelSandboxBaseUrl = (baseUrl: string): string =>
  baseUrl.replace(/\/+$/, "");

/**
 * Encode a workspace-relative path for use in Blaxel Sandbox API URL segments
 * (`/codegen/fastapply/{path}`, `/filesystem-content-search/{path}`, …).
 */
export const encodeBlaxelWorkspacePathForUrl = (relativePath: string): string => {
  const trimmed = relativePath.replace(/^\/+/, "");
  if (trimmed.length === 0) {
    return ".";
  }
  return trimmed
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
};

/**
 * Best-effort extraction of the sandbox **sidecar API** origin from a provider
 * `getInfo()` / metadata object. Mastra and Blaxel field names have shifted over
 * time — callers can always pass {@link BlaxelSandboxCodegenConfig.baseUrl}
 * explicitly from the Blaxel "Get sandbox" HTTP API.
 */
export const pickBlaxelSandboxApiBaseUrl = (info: unknown): string | null => {
  if (!info || typeof info !== "object") {
    return null;
  }
  const o = info as Record<string, unknown>;
  const keys = [
    "apiUrl",
    "apiURL",
    "endpoint",
    "baseUrl",
    "sandboxApiUrl",
    "sandboxUrl",
    "url",
  ] as const;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && /^https?:\/\//i.test(v.trim())) {
      return normalizeBlaxelSandboxBaseUrl(v.trim());
    }
  }
  return null;
};

export interface BlaxelSandboxCodegenConfig {
  /**
   * Sandbox API origin, e.g.
   * `https://sbx-{sandbox_id}-{workspace_id}.{region}.bl.run`
   * (see Blaxel OpenAPI `servers` for fastapply / filesystem routes).
   */
  baseUrl: string;
  /** Bearer JWT used as `Authorization: Bearer …` on the sandbox API. */
  token: string;
  timeout?: number;
  retry?: number;
  debug?: boolean;
}

export interface BlaxelFastApplyParams {
  /** Path relative to the workspace root (e.g. `app/src/main.ts`). */
  filePath: string;
  /** Edit instruction body per Blaxel fastapply docs (Morph / Relace). */
  codeEdit: string;
  /** Optional provider model id (e.g. `morph-v2`, `auto`). */
  model?: string;
}

export interface BlaxelFastApplyResult {
  success?: boolean;
  message?: string;
  path?: string;
  provider?: string;
  originalContent?: string;
  updatedContent?: string;
}

export interface BlaxelContentSearchParams {
  /** Directory to search under (use `.` or `""` for workspace root). */
  rootPath: string;
  /** Literal / regex-ish query string forwarded to ripgrep on the sandbox. */
  query: string;
  caseSensitive?: boolean;
  maxResults?: number;
  filePattern?: string;
  excludeDirs?: string;
}

export interface BlaxelContentSearchMatch {
  column: number;
  line: number;
  path: string;
  text: string;
  context?: string;
}

export interface BlaxelContentSearchResult {
  query: string;
  total: number;
  matches: BlaxelContentSearchMatch[];
}

export interface BlaxelCodeRerankingParams {
  /** Natural-language query (semantic code search). */
  query: string;
  /** Workspace-relative root for the reranking scope (default `.`). */
  rootPath?: string;
  scoreThreshold?: number;
  tokenLimit?: number;
  filePattern?: string;
}

export interface BlaxelCodeRerankingFile {
  path: string;
  score?: number;
  snippet?: string;
}

export interface BlaxelCodeRerankingResult {
  query: string;
  files: BlaxelCodeRerankingFile[];
}

export interface BlaxelSandboxCodegenClient {
  fastApply(params: BlaxelFastApplyParams): Promise<BlaxelFastApplyResult>;
  contentSearch(
    params: BlaxelContentSearchParams,
  ): Promise<BlaxelContentSearchResult>;
  /** Relace-style semantic file reranking (`GET /codegen/reranking/{path}`). */
  codeReranking(params: BlaxelCodeRerankingParams): Promise<BlaxelCodeRerankingResult>;
}

/**
 * Thin HTTP client for Blaxel **Sandbox API** codegen + ripgrep-backed search.
 * Uses the same routes as the sandbox MCP `codegenEditFile` / content search
 * tools — no `@blaxel/core` dependency; bring your own `baseUrl` + token.
 *
 * @see https://docs.blaxel.ai/Sandboxes/Codegen-tools.md
 */
export const createBlaxelSandboxCodegenClient = (
  config: BlaxelSandboxCodegenConfig,
): BlaxelSandboxCodegenClient => {
  const http = createHttpClient({
    baseURL: normalizeBlaxelSandboxBaseUrl(config.baseUrl),
    token: config.token,
    timeout: config.timeout,
    retry: config.retry,
    debug: config.debug,
  });

  return {
    async fastApply(params) {
      const path = encodeBlaxelWorkspacePathForUrl(params.filePath);
      return (await http(`/codegen/fastapply/${path}`, {
        method: "PUT",
        body: {
          codeEdit: params.codeEdit,
          ...(params.model != null && params.model !== ""
            ? { model: params.model }
            : {}),
        },
      })) as BlaxelFastApplyResult;
    },

    async contentSearch(params) {
      const path = encodeBlaxelWorkspacePathForUrl(
        params.rootPath.trim() === "" ? "." : params.rootPath,
      );
      const query: Record<string, string | number | boolean> = {
        query: params.query,
      };
      if (params.caseSensitive === true) {
        query.caseSensitive = true;
      }
      if (typeof params.maxResults === "number") {
        query.maxResults = params.maxResults;
      }
      if (params.filePattern != null && params.filePattern !== "") {
        query.filePattern = params.filePattern;
      }
      if (params.excludeDirs != null && params.excludeDirs !== "") {
        query.excludeDirs = params.excludeDirs;
      }
      return (await http(`/filesystem-content-search/${path}`, {
        method: "GET",
        query,
      })) as BlaxelContentSearchResult;
    },

    async codeReranking(params) {
      const path = encodeBlaxelWorkspacePathForUrl(
        params.rootPath?.trim() === "" || params.rootPath == null ? "." : params.rootPath,
      );
      const query: Record<string, string | number> = {
        query: params.query,
      };
      if (typeof params.scoreThreshold === "number") {
        query.scoreThreshold = params.scoreThreshold;
      }
      if (typeof params.tokenLimit === "number") {
        query.tokenLimit = params.tokenLimit;
      }
      if (params.filePattern != null && params.filePattern !== "") {
        query.filePattern = params.filePattern;
      }
      const raw = (await http(`/codegen/reranking/${path}`, {
        method: "GET",
        query,
      })) as Record<string, unknown>;

      const files: BlaxelCodeRerankingFile[] = [];
      const candidates = raw.files ?? raw.results ?? raw.matches;
      if (Array.isArray(candidates)) {
        for (const item of candidates) {
          if (item == null || typeof item !== "object") {
            continue;
          }
          const o = item as Record<string, unknown>;
          const filePath = o.path ?? o.filePath ?? o.file;
          if (typeof filePath !== "string" || filePath.trim() === "") {
            continue;
          }
          files.push({
            path: filePath.trim(),
            score: typeof o.score === "number" ? o.score : undefined,
            snippet:
              typeof o.snippet === "string"
                ? o.snippet
                : typeof o.content === "string"
                  ? o.content
                  : undefined,
          });
        }
      }

      return {
        query: params.query,
        files,
      };
    },
  };
};

/** Whether Blaxel semantic search is likely usable for progressive indexing. */
export const blaxelSemanticSearchAvailable = (
  client: BlaxelSandboxCodegenClient | null | undefined,
): boolean => client != null;
