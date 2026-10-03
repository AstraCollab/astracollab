import type { RepoIndexManifest, StartRepoIndexJobOptions } from "./types.js";
import { REPO_INDEX_MANIFEST_SCHEMA_VERSION } from "./types.js";
import { buildFileMerkleFromEntries, planIndexWork } from "./merkle.js";
import { chunkSourceFile, prioritizeIndexPaths } from "./chunk.js";
import { computePercentComplete } from "./resolve-state.js";
import { walkIndexableFiles } from "./walk-repo.js";

const DEFAULT_MAX_FILES = 8_000;
const DEFAULT_READY_PERCENT = 80;
const DEFAULT_CONCURRENCY = 4;
const EMBED_BATCH_SIZE = 32;

const runPool = async <T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> => {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      const item = items[idx];
      if (item === undefined) {
        break;
      }
      await fn(item);
    }
  });
  await Promise.all(workers);
};

export const startRepoIndexJob = async (opts: StartRepoIndexJobOptions): Promise<RepoIndexManifest> => {
  const { identity, repoFs, manifestStore, indexStore, embedBatch } = opts;
  const readyPercent = opts.readyPercent ?? DEFAULT_READY_PERCENT;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;

  const prior = await manifestStore.load(identity);
  const merkleEntries = await walkIndexableFiles({
    repoFs,
    repoRelativeRoot: opts.repoRelativeRoot,
    ignoreGlobs: opts.ignoreGlobs,
    maxFiles,
  });
  const merkle = buildFileMerkleFromEntries(merkleEntries);

  if (
    prior &&
    prior.gitHead === identity.gitHead &&
    prior.merkleRoot === merkle.root &&
    (prior.status === "ready" || prior.percentComplete >= readyPercent)
  ) {
    return prior;
  }

  const work = planIndexWork(
    merkle.entries,
    prior?.gitHead === identity.gitHead ? prior.fileHashes ?? null : null,
  );

  const toIndexPaths = prioritizeIndexPaths(
    work.added.length + work.changed.length > 0
      ? [...work.added, ...work.changed]
      : merkle.entries.map((e) => e.path),
    opts.profileHints,
  );

  if (work.deleted.length > 0 && indexStore.isConfigured()) {
    await indexStore.deleteChunksForPaths({ ...identity, paths: work.deleted });
  }

  let chunkCount = prior?.gitHead === identity.gitHead ? (prior.chunkCount ?? 0) : 0;
  let embeddedCount = prior?.gitHead === identity.gitHead ? (prior.embeddedCount ?? 0) : 0;

  const writeManifest = async (status: RepoIndexManifest["status"]): Promise<RepoIndexManifest> => {
    const percentComplete = computePercentComplete(embeddedCount, chunkCount);
    const manifest: RepoIndexManifest = {
      schemaVersion: REPO_INDEX_MANIFEST_SCHEMA_VERSION,
      orgId: identity.orgId,
      repoFullName: identity.repoFullName,
      gitHead: identity.gitHead,
      merkleRoot: merkle.root,
      fileCount: merkle.entries.length,
      fileHashes: merkle.entries,
      chunkCount,
      embeddedCount,
      percentComplete,
      status:
        percentComplete >= readyPercent
          ? "ready"
          : percentComplete > 0
            ? "partial"
            : status,
      updatedAt: new Date().toISOString(),
    };
    await manifestStore.save(manifest);
    await opts.onProgress?.(manifest);
    return manifest;
  };

  await writeManifest("building");

  if (!indexStore.isConfigured()) {
    chunkCount = 0;
    embeddedCount = 0;
    return writeManifest("building");
  }

  if (toIndexPaths.length === 0) {
    chunkCount = 0;
    embeddedCount = 0;
    return writeManifest("partial");
  }

  const repoRoot = repoFs.repoRoot;
  const allChunks: { path: string; chunks: ReturnType<typeof chunkSourceFile> }[] = [];

  await runPool(toIndexPaths, concurrency, async (relPath) => {
    const abs = `${repoRoot}/${relPath}`;
    let text: string;
    try {
      text = await repoFs.readText(abs);
    } catch {
      return;
    }
    const chunks = chunkSourceFile(relPath, text);
    if (chunks.length > 0) {
      allChunks.push({ path: relPath, chunks });
    }
  });

  const flatChunks = allChunks.flatMap((x) => x.chunks);
  chunkCount = flatChunks.length;
  embeddedCount = 0;
  await writeManifest("building");

  for (let offset = 0; offset < flatChunks.length; offset += EMBED_BATCH_SIZE) {
    const batch = flatChunks.slice(offset, offset + EMBED_BATCH_SIZE);
    const texts = batch.map((c) => `${c.path}\n${c.content}`);
    const vectors = await embedBatch(texts);
    await indexStore.upsertChunks({
      ...identity,
      chunks: batch,
      vectors,
    });
    embeddedCount += batch.length;
    await writeManifest("building");
  }

  return writeManifest(embeddedCount >= chunkCount * (readyPercent / 100) ? "ready" : "partial");
};
