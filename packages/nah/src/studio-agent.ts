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
import { createCodingTools, traceRun, type Span, type Trace } from "not-another-harness";

import { resolveInjection, runTurn } from "./session.js";
import { makeState } from "./state.js";

export type StudioAgentRun = {
  text: string;
  /** Null when sampling declined the run, which is the caller's cue to omit it. */
  trace: Trace | null;
  spans: Span[];
  /** Tool names in call order, refusals included. */
  toolsCalled: string[];
  /** Files actually written. A refused write is not here. */
  filesChanged: string[];
};

export type StudioAgent = {
  /** `provider:model-id`, or null when no credentials are configured. */
  model: string | null;
  run: (prompt: string) => Promise<StudioAgentRun>;
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
    state.tools = {
      ...state.tools,
      ...createCodingTools(state.workspace, { approveToolCall: async () => false, cwdLabel: state.cwd }),
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
    };
  };

  return { model: modelSpec, run };
};
