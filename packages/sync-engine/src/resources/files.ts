import type { SyncContext } from "../context";
import {
	type FilesQueryArgs,
	type RecentFilesQueryOptions,
	createOrgFilesQuery,
	createRecentOrgFilesQuery,
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
