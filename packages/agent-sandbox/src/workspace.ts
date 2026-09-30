import { Workspace, WORKSPACE_TOOLS, type WorkspaceToolName } from "@mastra/core/workspace";
import type { WorkspaceToolsConfig } from "@mastra/core/workspace";
import { createRepoWorkspaceFilesystemFromBlaxel } from "./adapters/mastra/index.js";
import { DEFAULT_CODING_SANDBOX_REPO_DIR } from "./coding-sandbox-repo-path.js";
import type { CodingWorkspaceOptions } from "./types.js";

/** Disable Mastra-shipped FS tools so {@link createCodingRepoFilesystemTools} can replace them on the agent. */
export const buildBuiltinWorkspaceFilesystemToolsDisabled = (): Partial<
  Record<WorkspaceToolName, { enabled: false }>
> => ({
  [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: { enabled: false },
  [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: { enabled: false },
  [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: { enabled: false },
  [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: { enabled: false },
  [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: { enabled: false },
  [WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT]: { enabled: false },
  [WORKSPACE_TOOLS.FILESYSTEM.MKDIR]: { enabled: false },
  [WORKSPACE_TOOLS.FILESYSTEM.GREP]: { enabled: false },
  [WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT]: { enabled: false },
});

const buildDefaultToolsConfig = (
  overrides?: WorkspaceToolsConfig,
  options?: { useAstraRepoFilesystemTools?: boolean },
): WorkspaceToolsConfig => {
  const useAstraRepoFilesystemTools = options?.useAstraRepoFilesystemTools === true;
  const defaults: WorkspaceToolsConfig = {
    enabled: true,
    requireApproval: false,
    ...(useAstraRepoFilesystemTools
      ? buildBuiltinWorkspaceFilesystemToolsDisabled()
      : {
          [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
            requireReadBeforeWrite: true,
          },
          [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: {
            requireReadBeforeWrite: true,
          },
        }),
    [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
      requireApproval: false,
    },
  };
  if (!overrides) {
    return defaults;
  }
  return { ...defaults, ...overrides };
};

/**
 * Build a Mastra `Workspace` configured as a "coding workspace" — a sandbox
 * with the standard read/write/edit/exec tool surface and safety defaults
 * (require-read-before-write on writes, no approvals on exec by default).
 *
 * Caller-provided fields (`runId`, `skills`, `tools`, `id`) are the main
 * extension points. Optional bundled Mastra skills and repo-path helpers live
 * in this package (`installBundledWorkspaceSkills`, `buildCodingWorkspaceSkillsResolver`).
 */
export const createCodingWorkspace = (options: CodingWorkspaceOptions) => {
  const repoRoot = options.repoRoot ?? DEFAULT_CODING_SANDBOX_REPO_DIR;
  const filesystem = options.getBlaxelInstance
    ? createRepoWorkspaceFilesystemFromBlaxel({
        getBlaxelInstance: options.getBlaxelInstance,
        repoRoot,
      })
    : undefined;

  return new Workspace({
    id: options.id ?? `agent-run-${options.runId}`,
    sandbox: options.sandbox,
    filesystem,
    skillSource: options.skillSource,
    skills: options.skills,
    tools: buildDefaultToolsConfig(options.tools, {
      useAstraRepoFilesystemTools: options.useAstraRepoFilesystemTools,
    }),
  });
};
