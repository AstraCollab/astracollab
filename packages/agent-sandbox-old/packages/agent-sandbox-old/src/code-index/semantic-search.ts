import type { BlaxelSandboxCodegenClient } from "../blaxel-sandbox-codegen.js";
import type {
  RepoIndexIdentity,
  RepoIndexStore,
  SemanticSearchHit,
  SemanticSearchResult,
} from "./types.js";

export type HybridSemanticSearchOptions = {
  identity: RepoIndexIdentity;
  query: string;
  topK?: number;
  indexStore: RepoIndexStore;
  blaxel?: BlaxelSandboxCodegenClient | null;
  /** When PgVector manifest percent >= this, prefer indexStore. */
  pgvectorAvailable: boolean;
  contentSearch?: (query: string, maxResults: number) => Promise<SemanticSearchHit[]>;
};

const mapContentSearchHits = (
  matches: { path: string; line: number; text: string; context?: string }[],
): SemanticSearchHit[] =>
  matches.map((m) => ({
    path: m.path,
    startLine: m.line,
    endLine: m.line,
    snippet: m.context ? `${m.text}\n${m.context}` : m.text,
  }));

export const hybridSemanticSearch = async (
  opts: HybridSemanticSearchOptions,
): Promise<SemanticSearchResult> => {
  const topK = opts.topK ?? 8;
  const query = opts.query.trim();
  if (!query) {
    return { query, backend: "grep", hits: [] };
  }

  if (opts.pgvectorAvailable && opts.indexStore.isConfigured()) {
    const hits = await opts.indexStore.semanticSearch({
      ...opts.identity,
      query,
      topK,
    });
    if (hits.length > 0) {
      return { query, backend: "pgvector", hits };
    }
  }

  if (opts.blaxel) {
    try {
      const reranked = await opts.blaxel.codeReranking({ query, tokenLimit: 12_000 });
      if (reranked.files.length > 0) {
        return {
          query,
          backend: "blaxel",
          hits: reranked.files.slice(0, topK).map((f) => ({
            path: f.path,
            score: f.score,
            snippet: f.snippet ?? "",
          })),
        };
      }
    } catch {
      // fall through
    }
  }

  if (opts.contentSearch) {
    const hits = await opts.contentSearch(query, topK);
    if (hits.length > 0) {
      return { query, backend: "grep", hits };
    }
  }

  return { query, backend: "grep", hits: [] };
};
