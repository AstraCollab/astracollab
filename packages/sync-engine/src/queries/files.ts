import { defineQuery, syncedQueryWithContext } from "@rocicorp/zero";
import { z } from "zod";
import { type SyncContext, isOrgAdminFromSyncCtx } from "../context";
import { builder } from "../schema";

export const FILE_SYNC_PAGE_SIZE = 200;

export const filesQueryArgsSchema = z.object({
	folderId: z.string().optional(),
	projectId: z.string().optional(),
	limit: z.number().int().positive().optional(),
});

export type FilesQueryArgs = z.infer<typeof filesQueryArgsSchema>;

export type RecentFilesQueryOptions = {
	folderId?: string;
	limit?: number;
};

const resolveLimit = (limit?: number) => {
	if (!limit || Number.isNaN(limit)) return FILE_SYNC_PAGE_SIZE;
	return Math.max(1, Math.min(limit, 5000));
};

const emptyFileQuery = () => builder.file.where("orgId", "=", "");

const applyNonAdminFileUploaderOrAssignee = (ctx: SyncContext, q: any) => {
	if (!isOrgAdminFromSyncCtx(ctx) && ctx.userId) {
		return q.where(({ cmp, or }: any) =>
			or(cmp("assigneeId", "=", ctx.userId), cmp("userId", "=", ctx.userId)),
		);
	}

	return q;
};

const withLinkedCollaborationContext = (q: any) => {
	return q
		.related("fileProjects", (fileProjectQ: any) => {
			return fileProjectQ.related("project");
		})
		.related("ticketAssets", (ticketAssetQ: any) => {
			return ticketAssetQ.related("ticket");
		});
};

const withOptionalFolder = (q: any, folderId?: string) => {
	if (!folderId || folderId === "undefined") return q;
	return q.where("folderId", "=", folderId);
};

const withOptionalProjectRelations = (q: any, projectId?: string) => {
	if (!projectId || projectId === "undefined") return q;

	return q.related("folder", (folderQ: any) => {
		return folderQ
			.related("folderProjects")
			.related("folderTeams", (folderTeamQ: any) => {
				return folderTeamQ.related("team", (teamQ: any) => {
					return teamQ.related("projects");
				});
			});
	});
};

export const createOrgFilesQuery = (
	ctx: SyncContext,
	args: FilesQueryArgs = {},
) => {
	if (!ctx.orgId) return emptyFileQuery();

	let q = builder.file
		.where("orgId", "=", ctx.orgId)
		.related("currentShareLink")
		.orderBy("order", "asc")
		.limit(resolveLimit(args.limit));

	q = withLinkedCollaborationContext(q);
	q = withOptionalFolder(q, args.folderId);
	q = withOptionalProjectRelations(q, args.projectId);

	return applyNonAdminFileUploaderOrAssignee(ctx, q);
};

export const createRecentOrgFilesQuery = (
	orgId: string,
	options: RecentFilesQueryOptions = {},
) => {
	if (!orgId) return emptyFileQuery();

	let q = builder.file
		.where("orgId", "=", orgId)
		.related("currentShareLink")
		.orderBy("createdAt", "desc")
		.limit(resolveLimit(options.limit));

	q = withOptionalFolder(q, options.folderId);

	return q;
};

export const legacyFileQueries = {
	orgFiles: syncedQueryWithContext(
		"org-files",
		z.union([z.tuple([]), z.tuple([z.string(), z.string()])]),
		(_ctx: Pick<SyncContext, "userId">, orgId?: string, folderId?: string) =>
			createRecentOrgFilesQuery(orgId ?? "", { folderId }),
	),
};

export const fileQueries = {
	files: {
		orgFiles: defineQuery(filesQueryArgsSchema, ({ ctx, args }) =>
			createOrgFilesQuery(ctx as SyncContext, args),
		),
	},
};
