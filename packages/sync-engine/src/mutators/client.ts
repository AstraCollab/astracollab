import { defineMutators } from "@rocicorp/zero";

/**
 * Shared client-safe mutators belong here.
 *
 * The current web mutator modules still import server/service helpers in several
 * places, so mobile should not consume them wholesale yet. Move mutators into
 * this package as each one is made platform-safe.
 */
export const clientMutators = defineMutators({});

export type ClientMutators = typeof clientMutators;
