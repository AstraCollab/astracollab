import { describe, expect, it } from "vitest";
import type { HarnessRunResult, PendingApproval } from "not-another-harness";

import { describeStop, flushStopNotice, type SessionState } from "../src/session.js";

const approval = (toolName: string, toolCallId: string): PendingApproval =>
  ({ approvalId: `a-${toolCallId}`, toolCallId, toolName, input: {} });

const result = (reason: string, pendingApprovals: PendingApproval[] = []): HarnessRunResult =>
  ({ reason, pendingApprovals }) as unknown as HarnessRunResult;

/** Only the field under test is populated; `flushStopNotice` reads nothing else. */
const withNotice = (stopNotice: string | null): SessionState => ({ stopNotice }) as SessionState;

/**
 * The SDK emits no tool result for a blocked call, so a held approval ends the
 * run. `done` resolves to that result and nah has nothing that answers the
 * hold, so without a named notice the TUI renders a task that halted mid-way
 * exactly like one that finished — the one failure the screen cannot explain.
 */
describe("a run that stopped for approval is named rather than finished", () => {
  it("says nothing for a run that completed", () => {
    expect(describeStop(result("completed"))).toBeNull();
  });

  it("says nothing for a run the user aborted", () => {
    expect(describeStop(result("aborted"))).toBeNull();
  });

  it("names every tool it is holding, and that the run cannot continue", () => {
    const notice = describeStop(result("awaiting-approval", [approval("bash", "c1"), approval("edit", "c2")]));

    expect(notice).toContain("Stopped");
    expect(notice).toContain("awaiting approval for bash, edit");
    expect(notice).toContain("cannot continue");
  });

  it("lists a tool held twice once", () => {
    const notice = describeStop(result("awaiting-approval", [approval("bash", "c1"), approval("bash", "c2")]));

    expect(notice).toContain("awaiting approval for bash");
    expect(notice).not.toContain("bash, bash");
  });

  it("still says something when the reason is right but no call is listed", () => {
    // The reason and the list are separate fields, and a notice that renders
    // empty is the silent failure this exists to remove.
    const notice = describeStop(result("awaiting-approval", []));

    expect(notice).toContain("awaiting approval for a tool call");
  });
});

/**
 * The TUI, the print mode and the REPL each await `done` and each has a
 * different writer. The clear lives here so a stop is announced once by every
 * host rather than re-printed by whichever of them remembers to reset the
 * field.
 */
describe("the notice is announced exactly once", () => {
  it("writes nothing on a turn that finished normally", () => {
    const written: string[] = [];

    flushStopNotice(withNotice(null), (line) => written.push(line));

    expect(written).toEqual([]);
  });

  it("writes the notice, then clears it so a later host does not repeat it", () => {
    const state = withNotice("Stopped — awaiting approval for bash.");
    const written: string[] = [];

    flushStopNotice(state, (line) => written.push(line));
    flushStopNotice(state, (line) => written.push(line));

    expect(written).toEqual(["Stopped — awaiting approval for bash."]);
    expect(state.stopNotice).toBeNull();
  });
});
