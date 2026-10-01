/**
 * The transcript pane of the alternate-screen TUI.
 *
 * A `Component` that turns harness events into wrapped `Text` blocks. Because
 * pi-tui repaints the whole layout on every frame, streaming text simply
 * appends to the last block and invalidates it — which is what keeps the editor
 * pinned at the bottom untouched no matter how fast output arrives.
 */
import { Text, type Component } from "@earendil-works/pi-tui";
import type { HarnessEvent } from "@astracollab/not-another-harness";

import { c, formatFileChange, stripAnsi, summarizeToolResult, toolLabel, type RenderableFileChange } from "../render.js";

/**
 * Strip bursts of orphaned SGR-mouse report text.
 *
 * When a terminal is left in mouse mode, `ESC[<35;107;19M` reaches the shell as
 * literal characters and can end up persisted in a session. Requiring **two or
 * more** consecutive reports keeps this from touching ordinary prose, which never
 * contains a run of `n;n;nM` tokens.
 */
const MOUSE_REPORT_RUN = /(?:\d{1,3};\s*\d{1,3};\s*\d{1,3}[Mm]\s*){2,}/g;

export const stripMouseReportText = (text: string): string =>
  text.replace(MOUSE_REPORT_RUN, "").replace(/[ \t]{2,}/g, " ");

/** `◆ label`, with a `×N` suffix once a run of identical calls collapses. */
const toolCallLine = (label: string, count: number): string =>
  `  ${c.cyan("◆")} ${label}${count > 1 ? c.dim(` ${"\u00d7"}${count}`) : ""}`;

export class TurnOutput implements Component {
  private readonly blocks: Text[] = [];
  private stream: Text | null = null;
  private streamBuffer = "";
  private renderedChanges = 0;
  private lastChanges: RenderableFileChange[] | null = null;

  constructor(
    private readonly getFileChanges: () => RenderableFileChange[] = () => [],
  ) {}

  /** Coalesced streaming assistant text, so a wall of deltas is one wrapping block. */
  appendStream(delta: string): void {
    this.streamBuffer += stripMouseReportText(delta);
    if (!this.stream) {
      this.stream = this.push("");
    }
    this.stream.setText(this.streamBuffer.trimStart());
  }

  /** A standalone line: tool call, result, notice, or divider. */
  addLine(text: string): void {
    this.stream = null;
    this.streamBuffer = "";
    this.push(stripMouseReportText(text));
  }

  /** Drop everything rendered so far, e.g. after switching sessions. */
  reset(): void {
    this.blocks.length = 0;
    this.group = null;
    this.groupInput = null;
    this.stream = null;
    this.streamBuffer = "";
    this.renderedChanges = 0;
    this.lastChanges = null;
  }

  /** Blank line separator. */
  addGap(): void {
    this.stream = null;
    this.streamBuffer = "";
    this.blocks.push(new Text("", 1, 0));
  }

  /** Current run of identical consecutive tool calls, collapsed to one line. */
  private group: { label: string; count: number; block: Text } | null = null;
  /** Input of the most recent call, so its result can be summarised in context. */
  private groupInput: unknown = null;

  apply(event: HarnessEvent): void {
    switch (event.type) {
      case "text-delta":
        this.appendStream(event.text);
        return;
      case "tool-call":
        this.addToolCall(toolLabel(event.toolName, event.input), event.input);
        return;
      case "tool-result": {
        const summary = summarizeToolResult(event.toolName, this.groupInput, event.output, event.isError);
        // Skip a line that would only restate the call above it, e.g.
        // "plan · step-1 → completed" followed by "step-1 → completed".
        const redundant =
          summary.show &&
          !event.isError &&
          this.group !== null &&
          summary.text.length > 0 &&
          stripAnsi(this.group.label).includes(summary.text);
        if (summary.show && !redundant) {
          const mark = event.isError ? c.red("✗") : c.dim("·");
          this.addLine(`    ${mark} ${event.isError ? c.red(summary.text) : c.dim(summary.text)}`);
        }
        // The group survives the result — calls and results always alternate,
        // so clearing it here would mean consecutive repeats never collapse.
        return;
      }
      case "user-message": {
        const label = event.delivery === "steer" ? "steering" : "follow-up";
        if (event.phase === "delivered") {
          this.addLine(`  ${c.magenta("↳")} ${c.dim(`${label} delivered`)}`);
        }
        return;
      }
      case "compacted":
        this.addLine(c.dim(`  ⋯ compacted ${event.droppedMessages} messages (${event.summaryChars} chars)`));
        return;
      case "step-finish":
        // A step boundary is the natural end of a run of repeats; the same call
        // in a later step is a separate decision and gets its own line.
        this.group = null;
        this.flushFileChanges();
        return;
      case "finish":
        this.addLine("");
        this.addLine(
          c.dim(
            `  ${event.reason} · ${event.usage.totalTokens} tokens${
              event.usage.estimated ? " (estimated)" : ""
            }`,
          ),
        );
        return;
      default:
        return;
    }
  }

  /**
   * Seed the pane with a resumed session so prior turns are visible.
   *
   * Without this the transcript is loaded into `state.messages` (and replayed to
   * the model) but the pane starts blank, which is indistinguishable from the
   * session having been lost. Tool traffic is summarised rather than replayed —
   * a long session's tool log would bury the conversation it belongs to.
   */
  seedHistory(messages: readonly unknown[]): void {
    if (messages.length === 0) return;
    let toolCalls = 0;

    for (const raw of messages) {
      const message = raw as { role?: string; content?: unknown };
      if (message.role === "user" && typeof message.content === "string") {
        this.addLine(`${c.magenta("❯")} ${message.content}`);
        continue;
      }
      if (message.role !== "assistant") continue;

      if (typeof message.content === "string") {
        this.addLine(`  ${message.content}`);
        continue;
      }
      if (!Array.isArray(message.content)) continue;

      // Array content: split the prose from the tool traffic.
      const text = (message.content as Array<Record<string, unknown>>)
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n")
        .trim();
      const calls = (message.content as Array<Record<string, unknown>>).filter(
        (part) => part.type === "tool-call",
      ).length;
      toolCalls += calls;
      if (text) this.addLine(`  ${text}`);
    }

    this.addLine("");
    const summary = toolCalls > 0 ? ` · ${toolCalls} tool calls` : "";
    this.addLine(c.dim(`  — resumed ${messages.length} earlier messages${summary} —`));
    this.addLine("");
  }

  /** File changes recorded during the step that just finished. */
  private flushFileChanges(): void {
    const changes = this.getFileChanges();
    // `activeFileChanges` is replaced with a fresh array at the start of every
    // turn. Without detecting that, the running counter from a previous turn
    // would exceed the new length and changes would silently stop rendering.
    if (changes !== this.lastChanges) {
      this.lastChanges = changes;
      this.renderedChanges = 0;
    }
    while (this.renderedChanges < changes.length) {
      const change = changes[this.renderedChanges++];
      if (!change) continue;
      this.addLine("");
      for (const line of formatFileChange(change)) this.addLine(line);
    }
  }

  /**
   * Record a tool call.
   *
   * Consecutive identical calls collapse into one line with a `×N` count. Six
   * successive bookkeeping calls used to print six near-identical lines, which
   * pushed the actual work out of view.
   */
  private addToolCall(label: string, input: unknown): void {
    this.stream = null;
    this.streamBuffer = "";
    this.groupInput = input;

    if (this.group && this.group.label === label) {
      this.group.count += 1;
      this.group.block.setText(toolCallLine(label, this.group.count));
      return;
    }
    this.group = { label, count: 1, block: this.push(toolCallLine(label, 1)) };
  }

  private push(text: string): Text {
    const block = new Text(text, 1, 0);
    this.blocks.push(block);
    return block;
  }

  /** True when the last thing rendered was streamed text rather than a tool line. */
  get hasOpenStream(): boolean {
    return this.stream !== null;
  }

  /** Number of rendered blocks, exposed for tests. */
  get blockCount(): number {
    return this.blocks.length;
  }

  render(width: number): string[] {
    return this.blocks.flatMap((block) => block.render(Math.max(1, width)));
  }

  invalidate(): void {
    for (const block of this.blocks) block.invalidate();
  }
}
