import type { EnsureRepoIndexOptions, EnsureRepoIndexResult } from "./types.js";
import { resolveRepoIndexState, semanticSearchAvailableForState } from "./resolve-state.js";

const DEFAULT_MIN_PERCENT = 80;

export const ensureRepoIndex = async (opts: EnsureRepoIndexOptions): Promise<EnsureRepoIndexResult> => {
  const manifest = await opts.manifestStore.load(opts.identity);
  const minPercent = opts.minPercentForPartial ?? DEFAULT_MIN_PERCENT;
  const state = resolveRepoIndexState({
    identity: opts.identity,
    manifest,
    minPercentForPartial: Math.min(40, minPercent),
    minPercentForReady: minPercent,
  });

  const semanticSearchAvailable =
    semanticSearchAvailableForState(state, minPercent, manifest) ||
    state === "ready";

  const stuckBuilding =
    state === "building" &&
    manifest != null &&
    manifest.percentComplete === 0 &&
    manifest.chunkCount === 0;

  const shouldStart =
    (state === "none" || state === "stale" || stuckBuilding) &&
    typeof opts.startJob === "function";

  if (shouldStart) {
    if (opts.background !== false) {
      void opts.startJob!().catch((e) => {
        console.warn("[ensureRepoIndex] background index job failed", e);
      });
      return {
        state: "building",
        manifest,
        semanticSearchAvailable: false,
      };
    }
    await opts.startJob!();
    const updated = await opts.manifestStore.load(opts.identity);
    const newState = resolveRepoIndexState({
      identity: opts.identity,
      manifest: updated,
      minPercentForPartial: Math.min(40, minPercent),
      minPercentForReady: minPercent,
    });
    return {
      state: newState,
      manifest: updated,
      semanticSearchAvailable: semanticSearchAvailableForState(newState, minPercent, updated),
    };
  }

  return { state, manifest, semanticSearchAvailable };
};
