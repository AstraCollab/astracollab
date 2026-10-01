import { Workspace, WORKSPACE_TOOLS, type WorkspaceToolName, type WorkspaceSandbox, type WorkspaceToolsConfig, type SkillSource, type SkillsResolver } from "@mastra/core/workspace";
import type { SandboxInstance } from "@blaxel/core";
import { createRepoWorkspaceFilesystemFromBlaxel } from "./repo-workspace-filesystem.js";
import { DEFAULT_CODING_SANDBOX_REPO_DIR } from "../../coding-sandbox-repo-path.js";

export interface CodingWorkspaceOptions {
  sandbox: WorkspaceSandbox;
  runId: string;
  repoRoot?: string;
  getBlaxelInstance?: () => SandboxInstance;
  skills?: SkillsResolver;
  skillSource?: SkillSource;
  useAstraRepoFilesystemTools?: boolean;
  tools?: WorkspaceToolsConfig;
  debug?: boolean;
  id?: string;
}

export const buildBuiltinWorkspaceFilesystemToolsDisabled = (): Partial<Record<WorkspaceToolName, { enabled: false }>> => ({
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

const buildDefaultToolsConfig = (overrides?: WorkspaceToolsConfig, useCustomFsTools = false): WorkspaceToolsConfig => ({
  enabled: true,
  requireApproval: false,
  ...(useCustomFsTools ? buildBuiltinWorkspaceFilesystemToolsDisabled() : {
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: { requireReadBeforeWrite: true },
    [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: { requireReadBeforeWrite: true },
  }),
  [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: { requireApproval: false },
  ...overrides,
});

/** Build a Mastra Workspace from an existing sandbox runtime. */
export const createCodingWorkspace = (options: CodingWorkspaceOptions) => {
  const repoRoot = options.repoRoot ?? DEFAULT_CODING_SANDBOX_REPO_DIR;
  const filesystem = options.getBlaxelInstance
    ? createRepoWorkspaceFilesystemFromBlaxel({ getBlaxelInstance: options.getBlaxelInstance, repoRoot })
    : undefined;
  return new Workspace({
    id: options.id ?? `agent-run-${options.runId}`,
    sandbox: options.sandbox,
    filesystem,
    skillSource: options.skillSource,
    skills: options.skills,
    tools: buildDefaultToolsConfig(options.tools, options.useAstraRepoFilesystemTools === true),
  });
};
