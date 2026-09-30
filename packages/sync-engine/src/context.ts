export type SyncContext = {
  userId: string;
  orgId: string;
  orgSlug?: string;
  role?: string;
  isAdmin?: boolean;
  teamIds?: string[];
  projectIds?: string[];
  linkedUserIds?: string[];
};

export const isOrgAdminRole = (role: string | undefined | null): boolean => {
  if (!role) return false;
  const normalizedRole = role.trim().toLowerCase();
  return (
    normalizedRole === "admin" ||
    normalizedRole === "org:admin" ||
    normalizedRole === "owner"
  );
};

export const isOrgAdminFromSyncCtx = (
  ctx: Pick<SyncContext, "isAdmin" | "role"> | null | undefined,
): boolean => {
  if (!ctx) return false;
  if (typeof ctx.isAdmin === "boolean") return ctx.isAdmin;
  return isOrgAdminRole(ctx.role);
};
