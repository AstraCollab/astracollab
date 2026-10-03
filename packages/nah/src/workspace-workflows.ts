import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createStep, createWorkflow, createWorkflowRegistry, type Workflow, type WorkflowRegistry } from "not-another-harness";

/**
 * Workflows the user described in English, kept as files next to the project.
 *
 * The two workflows nah ships are code in `workflows.ts`, which means asking for
 * a new one meant either a rebuild or a turn of improvised tool calls that the
 * next request would not repeat. A workflow is worth having precisely when it is
 * run again, so it belongs somewhere the user can keep it: one file per workflow
 * under `.nah/workflows`, found by name, editable by hand, and versionable with
 * the project it describes.
 */

/** Where workspace workflows live, relative to the workspace root. */
export const WORKSPACE_WORKFLOW_DIR = ".nah/workflows";

/**
 * `.mjs` only in practice, because a workflow file cannot import TypeScript.
 * `.js` is accepted for a repo that already declares it as ESM.
 */
const WORKFLOW_EXTENSIONS = [".mjs", ".js"];

export const workspaceWorkflowDir = (cwd: string): string => join(cwd, ...WORKSPACE_WORKFLOW_DIR.split("/"));

/**
 * The API handed to a workflow file.
 *
 * A file under the workspace resolves `node_modules` from the workspace root, not
 * from nah's own package, so `import { createWorkflow } from "not-another-harness"`
 * fails in most repositories. Rather than have the file resolve something it has
 * no way to resolve, the loader passes the API in and the file default-exports a
 * function that takes it. `z` rides along for the same reason.
 */
const workflowApi = { createStep, createWorkflow, createWorkflowRegistry, z } as const;

const isWorkflow = (value: unknown): value is Workflow => Boolean((value as { __workflow?: boolean } | undefined)?.__workflow);

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The workflows a module exports, in every shape worth accepting.
 *
 * A factory (the documented form), one workflow, or a record of them for a file
 * that is a small library rather than a single sequence.
 */
const exportedWorkflows = (exported: unknown, file: string, depth = 0): Workflow[] => {
  if (typeof exported === "function") {
    if (depth > 0) throw new Error(`${file}: exports a function that does not return a workflow`);
    return exportedWorkflows((exported as (api: typeof workflowApi) => unknown)(workflowApi), file, depth + 1);
  }
  if (isWorkflow(exported)) return [exported];
  if (exported && typeof exported === "object") {
    const entries = Object.entries(exported as Record<string, unknown>);
    if (entries.length === 0) throw new Error(`${file}: exports an empty object`);
    return entries.map(([key, value]) => {
      if (!isWorkflow(value)) throw new Error(`${file}: "${key}" is not a workflow`);
      return value;
    });
  }
  throw new Error(`${file}: default-exports ${exported === undefined ? "nothing" : `a ${typeof exported}`}, not a workflow`);
};

const importFile = async (file: string): Promise<Workflow[]> => {
  const { mtimeMs } = await stat(file);
  // The query string is load-bearing: Node caches modules by URL, so without it a
  // workflow the agent rewrote two minutes ago would keep running its first draft.
  const module = (await import(`${pathToFileURL(file).href}?nah=${mtimeMs}`)) as Record<string, unknown>;
  return exportedWorkflows(module.default, file);
};

export const listWorkspaceWorkflowFiles = async (cwd: string): Promise<string[]> => {
  const dir = workspaceWorkflowDir(cwd);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && WORKFLOW_EXTENSIONS.some((extension) => entry.name.endsWith(extension)))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    // No directory yet is the normal state of a workspace that has no workflows,
    // and not an error worth reporting to the user.
    return [];
  }
};

export type WorkspaceWorkflowLoadResult = {
  loaded: Array<{ file: string; ids: string[] }>;
  failed: Array<{ file: string; error: string }>;
};

/**
 * Import every workflow file and register what came out.
 *
 * Failures are collected rather than thrown: one file that does not parse is a
 * broken sequence, and losing the others with it would be a worse answer than
 * naming the file that is wrong.
 */
export const loadWorkspaceWorkflows = async (options: { cwd: string; registry?: WorkflowRegistry }): Promise<WorkspaceWorkflowLoadResult> => {
  const loaded: WorkspaceWorkflowLoadResult["loaded"] = [];
  const failed: WorkspaceWorkflowLoadResult["failed"] = [];
  for (const file of await listWorkspaceWorkflowFiles(options.cwd)) {
    try {
      const workflows = await importFile(file);
      for (const workflow of workflows) options.registry?.register(workflow);
      loaded.push({ file, ids: workflows.map(({ id }) => id) });
    } catch (error) {
      failed.push({ file, error: message(error) });
    }
  }
  return { loaded, failed };
};

/**
 * Find one workflow by name, from the registry or from a file nobody has loaded.
 *
 * This is what makes `/workflow new` end-to-end: the file the agent just wrote is
 * runnable in the same session, instead of after a restart nobody would think to do.
 */
export const resolveWorkspaceWorkflow = async (options: {
  cwd: string;
  registry: WorkflowRegistry;
  id: string;
}): Promise<Workflow | undefined> => {
  const registered = options.registry.get(options.id);
  if (registered) return registered;
  for (const file of await listWorkspaceWorkflowFiles(options.cwd)) {
    let workflows: Workflow[];
    try {
      workflows = await importFile(file);
    } catch {
      // A sibling that will not parse is not the reason the requested one is
      // missing, so it must not stop the search.
      continue;
    }
    const match = workflows.find(({ id }) => id === options.id);
    if (match) {
      // Throws on a genuine id clash between two files, which is worth hearing about.
      options.registry.register(match);
      return match;
    }
  }
  return undefined;
};

/**
 * What the agent is told when the user asks for a workflow in plain English.
 *
 * The order is the point. The questions come before the file, because a workflow
 * built on a guessed branch or a guessed path looks finished and then fails on the
 * one request that mattered. Memory is the deliberate exception: durable facts about
 * the project belong in memory, this workflow's own parameters belong in its schema.
 */
export const workspaceWorkflowBrief = (description: string): string =>
  [
    "The user wants a new workflow in this workspace, described in their own words:",
    "",
    description,
    "",
    "A workflow is a sequence that runs the same steps in the same order every time, so this request is done the same way next week as it is being done now. It is one file under",
    `${WORKSPACE_WORKFLOW_DIR}/, and it is run by name with /workflow <id> or the run_workflow tool. Do this in order.`,
    "",
    "1. Ground it in the repository first. Read the workflows already in that directory and the `not-another-harness` package's workflow.ts for the builder (.then, .parallel, .branch, .map, .commit, createStep, StepExecuteArgs). Use delegate_tasks or bash to find the real things the description names — the scripts, paths, refs and commands that exist here — instead of guessing at their names. A workflow that names a script this project does not define fails on the run that mattered.",
    "",
    "2. Write down the steps. Each gets a kebab-case id and a one-line description saying what it produces, what it consumes, and what the workflow's final output is.",
    "",
    "3. Ask before you build. List only what you cannot learn from the description or the repository AND that the workflow genuinely needs to run end to end — a base ref to compare against, a path to publish to, which environment to target, who signs off. Ask them in one message, as few as possible, each with the default you would pick and why. Do not write the file, and do not paper over a gap with an assumption, until they are answered. Do not ask what you can look up, and do not ask again about something already answered in this conversation.",
    "",
    `4. Once they answer, write one file: ${WORKSPACE_WORKFLOW_DIR}/<id>.mjs, default-exporting a function that receives the API. It receives it rather than importing it, because a file in the workspace resolves node_modules from the workspace root and would not find the package.`,
    "",
    "```js",
    "export default ({ createStep, createWorkflow, z }) =>",
    '  createWorkflow({',
    '    id: "<kebab-case-id>",',
    '    description: "What it does, and what input it expects.",',
    "    inputSchema: z.object({ target: z.string().describe(\"...\") }),",
    "    outputSchema: z.object({ ... }),",
    "  })",
    "    .then(theStep)",
    '    .map({ inputKey: "items", outputKey: "results", mapper: (item) => theStep })',
    "    .commit();",
    "```",
    "",
    "Each step is createStep({ id, description, inputSchema?, outputSchema?, execute }) and execute receives { inputData, context, signal }. A step that needs judgement delegates through context.delegate({ title, task, signal }). A step that only gathers facts — git, package.json, a file — runs them inline: a child agent is a model call to obtain a string the shell already knows, and can get it wrong in a way that only shows up as an mysteriously empty result.",
    "",
    "5. Register nothing yourself. nah finds the file when it is run, and picks up an edited one straight away.",
    "",
    "6. End by telling the user the workflow's name, its steps in one line each, the input it takes, and the exact command that runs it. Offer to run it — do not run it unprompted, since most of them touch the repository.",
    "",
    "Memory: record what is durable about this project (how it is built, checked, deployed, what its conventions are) with the remember tool. Do not put this workflow's parameters in memory; they belong in its inputSchema.",
  ].join("\n");
