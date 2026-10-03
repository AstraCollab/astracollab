/**
 * The workflow surface the Studio imports.
 *
 * A workflow in a workspace is a file under `.nah/workflows`, and the rules about
 * where those files live, how they are loaded, and how an edited one is picked up
 * belong to `nah` rather than to any dashboard that wants to show them. So this is
 * the same entry-point trick as `./agent`: the Studio asks `nah` what workflows
 * exist instead of carrying a second loader that would drift from the first.
 */

export {
  WORKSPACE_WORKFLOW_DIR,
  listWorkspaceWorkflowFiles,
  loadWorkspaceWorkflows,
  resolveWorkspaceWorkflow,
  workspaceWorkflowDir,
  type WorkspaceWorkflowLoadResult,
} from "./workspace-workflows.js";

export { createNahWorkflows, type NahWorkflowOptions } from "./workflows.js";