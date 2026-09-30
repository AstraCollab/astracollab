export type ModelOption = {
  provider: "anthropic" | "openai" | "openrouter";
  id: string;
  name: string;
};

const fallback: ModelOption[] = [
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  { provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1" },
  { provider: "openai", id: "gpt-5", name: "GPT-5" },
  { provider: "openai", id: "gpt-5-mini", name: "GPT-5 Mini" },
  { provider: "openrouter", id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
  { provider: "openrouter", id: "openai/gpt-5", name: "GPT-5" },
];

let cached: { at: number; options: ModelOption[] } | undefined;

export const getModelOptions = async (): Promise<ModelOption[]> => {
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.options;

  try {
    const response = await fetch("https://models.dev/api.json", {
      signal: AbortSignal.timeout(3500),
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`model catalog returned HTTP ${response.status}`);
    const catalog = await response.json() as Record<string, {
      name?: string;
      models?: Record<string, {
        name?: string;
        tool_call?: boolean;
        modalities?: { input?: string[]; output?: string[] };
      }>;
    }>;

    const providers = ["anthropic", "openai", "openrouter"] as const;
    const options = providers.flatMap((provider) => {
      const entry = catalog[provider];
      if (!entry?.models) return [];
      return Object.entries(entry.models)
        .filter(([, model]) => model.tool_call !== false && model.modalities?.output?.includes("text") !== false)
        .map(([id, model]) => ({
          provider,
          id,
          name: model.name ?? id,
        }));
    });
    if (!options.length) throw new Error("model catalog was empty");
    cached = { at: Date.now(), options };
    return options;
  } catch {
    cached = { at: Date.now() - 50 * 60 * 1000, options: fallback };
    return fallback;
  }
};

export const filterModelOptions = (
  options: ModelOption[],
  query: string,
): ModelOption[] => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return options;
  const words = normalized.split(/\s+/);
  const score = (option: ModelOption): number | null => {
    const haystack = `${option.provider}:${option.id} ${option.name}`.toLowerCase();
    let total = 0;
    for (const word of words) {
      const exact = haystack.indexOf(word);
      if (exact >= 0) {
        total += exact === 0 ? 0 : exact;
        continue;
      }
      let cursor = 0;
      let gaps = 0;
      for (const char of word) {
        const found = haystack.indexOf(char, cursor);
        if (found < 0) return null;
        gaps += found - cursor;
        cursor = found + 1;
      }
      total += 100 + gaps;
    }
    return total;
  };

  return options
    .map((option) => ({ option, rank: score(option) }))
    .filter((entry): entry is { option: ModelOption; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.option.name.localeCompare(b.option.name))
    .map(({ option }) => option);
};
