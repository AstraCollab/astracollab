import type { SyncContext } from "../context";
import { createOrgFilesQuery, createRecentOrgFilesQuery } from "../queries/files";

export const createMobileRecentFilesQuery = (
  orgId: string | null | undefined,
  options: { limit?: number } = {},
) => {
  const normalizedOrgId = orgId ?? "";
  if (!normalizedOrgId) return false;
  return createRecentOrgFilesQuery(normalizedOrgId, options);
};

export const createWorkspaceFilesQuery = (
  ctx: SyncContext,
  options: { folderId?: string; projectId?: string; limit?: number } = {},
) => createOrgFilesQuery(ctx, options);
