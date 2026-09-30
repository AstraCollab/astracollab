import type { SyncContext } from "../context";
import {
  createOrgFilesQuery,
  createRecentOrgFilesQuery,
  type FilesQueryArgs,
  type RecentFilesQueryOptions,
} from "../queries/files";

export class FilesResource {
  orgFiles(ctx: SyncContext, args: FilesQueryArgs = {}) {
    return createOrgFilesQuery(ctx, args);
  }

  recent(orgId: string, options: RecentFilesQueryOptions = {}) {
    return createRecentOrgFilesQuery(orgId, options);
  }
}

export const createFilesResource = (): FilesResource => new FilesResource();
