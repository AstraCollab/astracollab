/** Shared provider-agnostic configuration shape for future AI subpackages. */
export interface ProviderConfig {
  apiKey: string;
  baseURL: string;
  timeout?: number;
  retry?: number;
  debug?: boolean;
}

export type { ProviderConfig as AiProviderConfig };
