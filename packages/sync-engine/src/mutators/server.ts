import { defineMutators } from "@rocicorp/zero";

/**
 * Server-only mutators should be composed here after the current web mutators
 * are split into platform-safe cores and server adapters.
 */
export const serverMutators = defineMutators({});

export type ServerMutators = typeof serverMutators;
