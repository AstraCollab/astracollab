import type { SkillsContext, SkillsResolver } from "@mastra/core/workspace";

import { BUNDLED_WORKSPACE_SKILL_RELATIVE_PATHS } from "./bundled-workspace-skills.js";

const dedupeSkillPaths = (paths: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p || seen.has(p)) {
      continue;
    }
    seen.add(p);
    out.push(p);
  }
  return out;
};

/**
 * Static paths merged into every resolver result: bundled upstream skills
 * (after sandbox install), optional `MASTRA_SKILL_PATHS`, and repo-local
 * `.agents/skills`. Set `MASTRA_SKIP_BUNDLED_SKILLS=1` to omit vendored trees.
 */
const collectBaseSkillPaths = (): string[] => {
  const paths: string[] = [];
  const skipBundled =
    process.env.MASTRA_SKIP_BUNDLED_SKILLS === "1" ||
    process.env.MASTRA_SKIP_BUNDLED_SKILLS === "true";
  if (!skipBundled) {
    paths.push(...BUNDLED_WORKSPACE_SKILL_RELATIVE_PATHS);
  }
  const fromEnv = process.env.MASTRA_SKILL_PATHS?.split(":").filter(Boolean);
  if (fromEnv?.length) {
    paths.push(...fromEnv);
  }
  paths.push("./.agents/skills");
  return dedupeSkillPaths(paths);
};

const ticketCodingScoutDisableSkills = (): boolean => {
  const v = process.env.TICKET_CODING_SCOUT_DISABLE_SKILLS?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") {
    return false;
  }
  return true;
};

/**
 * Mastra `Workspace` `skills` resolver: stable defaults plus optional
 * `requestContext` keys for dynamic paths (`workspaceSkillPaths`, `userRole`).
 * When `requestContext.ticketCodingScout === true` and scout skill disable is on
 * (default), returns no skill paths to keep scout prompts small.
 */
export const buildCodingWorkspaceSkillsResolver = (): SkillsResolver => {
  return (ctx: SkillsContext) => {
    if (
      ticketCodingScoutDisableSkills() &&
      ctx.requestContext?.get("ticketCodingScout") === true
    ) {
      return [];
    }
    const paths = collectBaseSkillPaths();
    const dynamicExtra = ctx.requestContext?.get("workspaceSkillPaths");
    if (Array.isArray(dynamicExtra)) {
      for (const item of dynamicExtra) {
        if (typeof item === "string" && item.trim()) {
          paths.push(item.trim());
        }
      }
    }
    const role = ctx.requestContext?.get("userRole");
    if (
      (role === "developer" || role === "org_admin") &&
      process.env.MASTRA_DEVELOPER_SKILL_PATHS?.trim()
    ) {
      paths.push(
        ...process.env.MASTRA_DEVELOPER_SKILL_PATHS.split(":").filter(Boolean),
      );
    }
    return dedupeSkillPaths(paths);
  };
};
