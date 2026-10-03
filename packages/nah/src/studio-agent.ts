/**
 * The read-only agent the Studio talks to.
 *
 * The Studio is a debugging tool, so its agent is assembled from the same parts
 * the terminal uses — the same system prompt, the same tools, the same model
 * resolution and the same memory — and then has one difference: every
 * mutating tool is refused. Debugging a different agent than the one you use
 * would make the traces in the dashboard evidence about the wrong program.
 *
 * Each run gets a fresh state. An HTTP request has no transcript to inherit, and
 * a turn that silently carried the previous one's history could answer a question
 * about a file it never read.
 */
import { createCodingTools, sharedWorkspaceIsolation, traceRun, type Orchestrator, type Span, type Trace, type WorkflowRegistry } from "not-another-harness";

import { resolveInjection, runTurn } from "./session.js";
import { makeState } from "./state.js";
import { isReadonlyAllowed } from "./permissions.js";
import { createSessionOrchestrator } from "./delegation.js";
import { createNahWorkflows } from "./workflows.js";
import { loadWorkspaceWorkflows } from "./workspace-workflows.js";

export type StudioAgentRun = {
  text: string;
  /** Null when sampling declined the run, which is the caller's cue to omit it. */
  trace: Trace | null;
  spans: Span[];
  /** Tool names in call order, refusals included. */
  toolsCalled: string[];
  /** Files actually written. A refused write is not here. */
  filesChanged: string[];
  /**
   * Why the run stopped short of an answer, or null when it finished.
   *
   * Kept beside `text` rather than appended to it: a held tool call ends the run
   * with no answer at all, and a caller that only reads `text` cannot tell that
   * apart from a run that simply had nothing to say.
   */
  stopNotice: string | null;
};

/**
 * What the Studio needs to run a workflow: the registry that resolves a name to a
 * workflow, and the orchestrator that runs it.
 */
export type StudioWorkflowRunner = {
  registry: WorkflowRegistry;
  /**
   * Runs a workflow's steps, delegating the ones that need judgement to child
   * agents. Built from the same prompt and tools as a session's, so the children
   * in a Studio run are the children the terminal would have spawned — with every
   * mutating tool refused.
   */
  orchestrator: Orchestrator;
};

export type StudioAgent = {
  /** `provider:model-id`, or null when no credentials are configured. */
  model: string | null;
  run: (prompt: string) => Promise<StudioAgentRun>;
  /**
   * The workspace's workflows and what runs them, or null when no model is
   * configured. Null rather than a runner that fails on the first step: a
   * workflow is mostly model calls, and "no credentials" is a fact the Studio
   * should show rather than a failure to raise once somebody clicks run.
   */
  workflows: StudioWorkflowRunner | null;
};

export type StudioAgentOptions = {
  cwd: string;
  /** `provider:model-id`. Falls back to the saved model, then the default. */
  model?: string;
};

/**
 * Assemble the agent once; run as many turns against it as the browser asks for.
 *
 * The model is resolved up front so a missing key is reported when the server
 * starts, where the banner can print it, rather than as a 500 per keystroke.
 */
export const createReadonlyAgent = async (options: StudioAgentOptions): Promise<StudioAgent> => {
  const probe = await makeState({
    cwd: options.cwd,
    noSession: true,
    permissions: "readonly",
    allowUnconfiguredModel: true,
    // This agent runs inside the Studio. It saves its own traces, so reporting to
    // the endpoint file would record every run twice.
    telemetry: false,
    ...(options.model === undefined ? {} : { modelSpec: options.model }),
  });
  const modelSpec = probe.model?.spec ?? null;
  const workflows = await studioWorkflowRunner(probe);

  const run = async (prompt: string): Promise<StudioAgentRun> => {
    const state = await makeState({
      cwd: options.cwd,
      noSession: true,
      permissions: "readonly",
      allowUnconfiguredModel: true,
      telemetry: false,
      ...(modelSpec === null ? {} : { modelSpec }),
    });
    if (!state.model) {
      throw new Error("no model is configured. Set a provider key, then pass --model provider:model-id.");
    }

    // The same tools, re-approved. `state.workspace` is the workspace root the
    // terminal confines to, not the bare cwd, so the two agree about which
    // files are in bounds.
    //
    // Everything that can change something is refused, with one exception:
    // `isReadonlyAllowed` covers the gated tools that do not touch the
    // workspace, which `readonly` permits in the terminal too. Without it this
    // agent would carry a `web_fetch` that denies every call — a tool in the
    // schema that cannot work, which the model spends a step rediscovering.
    state.tools = {
      ...state.tools,
      ...createCodingTools(state.workspace, {
        approveToolCall: async (name) => !isReadonlyAllowed(name),
        cwdLabel: state.cwd,
      }),
    };

    const injection = await resolveInjection(state, prompt);
    const turn = runTurn(state, prompt, {}, injection);

    const spans: Span[] = [];
    const traced = traceRun(
      {
        sink: { emit: (span) => void spans.push(span) },
        serviceName: "nah",
        tags: ["studio"],
        metadata: { "nah.agent.cwd": options.cwd, "nah.agent.readonly": true },
      },
      turn.events,
      { rootSpanName: prompt.slice(0, 60), input: prompt, model: state.model.spec },
    );

    const result = await turn.done;
    const trace = await traced;

    return {
      text: result.text,
      trace,
      spans,
      toolsCalled: spans
        .filter((span) => span.kind === "tool")
        .map((span) => String(span.attributes["nah.tool.name"] ?? span.name)),
      // Read off what the turn recorded rather than off the tool spans: a span
      // exists for a write that was refused, and a file that was not written is
      // not a changed file.
      filesChanged: (state.activeFileChanges ?? []).map((change) => change.path),
      // Read rather than flushed: this state is built per request and dropped
      // when the run returns, so there is no later render to clear it for.
      stopNotice: state.stopNotice ?? null,
    };
  };

  return { model: modelSpec, run, workflows };
};

/**
 * The workspace's workflows, plus an orchestrator that runs them.
 *
 * The orchestrator is the session's own factory rather than a second assembly, so
 * a workflow the Studio runs delegates to children with the same prompt and the
 * same tools the terminal would have given them. Two things differ from a
 * session, both deliberate: `approve` refuses every mutating tool, as the rest of
 * this agent does, and children share the caller's workspace instead of getting a
 * git worktree each — a worktree per child is how a session keeps half-finished
 * edits reviewable, and there is nothing to review when nothing can be written.
 */
const studioWorkflowRunner = async (
  probe: Awaited<ReturnType<typeof makeState>>,
): Promise<StudioWorkflowRunner | null> => {
  if (!probe.model) return null;
  const registry = createNahWorkflows({ cwd: probe.cwd });
  // Loaded once, here, for the same reason the probe exists: a broken file is
  // reported by the caller that lists workflows, not swallowed to make a registry.
  await loadWorkspaceWorkflows({ cwd: probe.cwd, registry });
  return {
    registry,
    orchestrator: createSessionOrchestrator({
      cwd: probe.cwd,
      system: probe.system,
      getModel: () => probe.model!.model,
      approve: async () => false,
      onChildUsage: () => undefined,
      isolation: sharedWorkspaceIsolation(),
    }),
  };
};
