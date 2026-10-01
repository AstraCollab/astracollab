/**
 * The transcript pane of the alternate-screen TUI.
 *
 * A `Component` that turns harness events into rendered blocks. Because pi-tui
 * repaints the whole layout on every frame, streaming text simply appends to
 * the last block and invalidates it — which is what keeps the editor pinned at
 * the bottom untouched no matter how fast output arrives.
 *
 * Two block kinds share the pane. Assistant prose goes through pi-tui's
 * `Markdown` so a `##` heading or a `-` list renders as structure rather than
 * as literal characters; tool lines, results, and diffs stay plain `Text`,
 * because they are already formatted and running them back through a markdown
 * parser would mangle shell output that happens to contain `-` or `*`.
 */
import { Text, type Component } from "@earendil-works/pi-tui";
import type { HarnessEvent } from "@astracollab/not-another-harness";

import { c, formatFileChange, stripAnsi, summarizeToolResult, toolLabel, type RenderableFileChange } from "../render.js";
import { markdownBlock } from "./theme.js";

/**
 * Strip bursts of orphaned SGR-mouse report text.
 *
 * When a terminal is left in mouse mode, `ESC[<35;107;19M` reaches the shell as
 * literal characters and can end up persisted in a session. Requiring **two or
 * more** consecutive reports keeps this from touching ordinary prose, which never
 * contains a run of `n;n;nM` tokens.
 *
 * The pattern's trailing `\s*` already consumes the whitespace at the seam, so
 * removal alone leaves no double space behind. An earlier version also collapsed
 * runs of two or more spaces, which was redundant for reports and destroyed
 * markdown indentation — nested list items and indented code blocks.
 */
const MOUSE_REPORT_RUN = /(?:\d{1,3};\s*\d{1,3};\s*\d{1,3}[Mm]\s*){2,}/g;

export const stripMouseReportText = (text: string): string => text.replace(MOUSE_REPORT_RUN, "");

/** `◆ label`, with a `×N` suffix once a run of identical calls collapses. */
const toolCallLine = (label: string, count: number): string =>
  `  ${c.cyan("◆")} ${label}${count > 1 ? c.dim(` ${"\u00d7"}${count}`) : ""}`;

type MessagePart = Record<string, unknown>;

const partsOf = (content: unknown): MessagePart[] =>
  Array.isArray(content) ? (content as MessagePart[]) : [];

/** First line of `text`, clipped. Reasoning is a log, not a transcript. */
const clipLine = (text: string, max: number): string => {
  const first = text.trim().split("\n")[0] ?? "";
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
};

/**
 * Prose of a user message.
 *
 * Array-shaped user content is how the transcript records an attached file, so
 * accepting only `typeof content === "string"` silently dropped every prompt
 * that carried one.
 */
const userText = (content: unknown): string => {
  if (typeof content === "string") return content;
  const parts = partsOf(content);
  const text = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim();
  const files = parts.filter((part) => part.type === "file").length;
  if (files === 0) return text;
  const note = c.dim(`(+${files} file${files === 1 ? "" : "s"})`);
  return text ? `${text} ${note}` : c.dim(`(${files} attached file${files === 1 ? "" : "s"})`);
};

/** `· result` for a restored `tool-result`, in the live renderer's shape. */
const restoredResultLine = (part: MessagePart): string => {
  const toolName = typeof part.toolName === "string" ? part.toolName : "tool";
  const output = part.output as { value?: unknown } | string | undefined;
  const text =
    typeof output === "string"
      ? output
      : typeof output?.value === "string"
        ? output.value
        : output === undefined || output === null
          ? ""
          : JSON.stringify(output);
  const summary = summarizeToolResult(toolName, undefined, text.slice(0, 2000), false);
  return summary.show ? `    ${c.dim("·")} ${c.dim(summary.text)}` : "";
};

/**
 * The one capability the streaming path needs beyond `Component`.
 *
 * `Text` and `Markdown` both expose it, so naming it here keeps the stream typed
 * without a cast at every `setText`.
 */
type SettableBlock = Component & { setText(text: string): void };

export class TurnOutput implements Component {
  private readonly blocks: Component[] = [];
  private stream: SettableBlock | null = null;
  private streamBuffer = "";
  private renderedChanges = 0;
  private lastChanges: RenderableFileChange[] | null = null;

  constructor(
    private readonly getFileChanges: () => RenderableFileChange[] = () => [],
  ) {}

  /**
   * Coalesced streaming assistant text, so a wall of deltas is one block.
   *
   * Markdown, not `Text`: a response that opens with `## Setup` was rendering
   * its heading characters verbatim. The block is replaced on first delta so a
   * stream that follows a tool result starts its own block.
   */
  appendStream(delta: string): void {
    this.streamBuffer += stripMouseReportText(delta);
    if (!this.stream) {
      this.stream = this.pushMarkdown("");
    }
    this.stream.setText(this.streamBuffer.trimStart());
  }

  /** A standalone line: tool call, result, notice, or divider. */
  addLine(text: string): void {
    this.stream = null;
    this.streamBuffer = "";
    this.push(stripMouseReportText(text));
  }

  /**
   * A finished markdown block, e.g. a restored response.
   *
   * Separate from `addLine` so restored prose is parsed while tool lines and
   * diffs are not.
   */
  addMarkdown(text: string): void {
    this.stream = null;
    this.streamBuffer = "";
    this.pushMarkdown(stripMouseReportText(text));
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
   * session having been lost. Everything the live renderer shows is rebuilt
   * here, through the same `toolLabel`/`summarizeToolResult` path, so a resumed
   * session reads like the session that produced it: prose, tool calls, their
   * results, and reasoning. Filtering the tool traffic out of the restored view
   * left 34 messages rendering as three lines and made the log look truncated.
   */
  seedHistory(messages: readonly unknown[]): void {
    if (messages.length === 0) return;
    const list = messages as Array<{ role?: string; content?: unknown }>;
    let toolCalls = 0;

    for (const message of list) {
      if (message.role === "user") {
        this.addLine(`${c.magenta("❯")} ${userText(message.content)}`);
        continue;
      }
      if (message.role === "tool") {
        // Stored results are their own messages rather than parts of the call,
        // so they are rendered here. Reusing the live summarizer keeps a
        // restored session from dumping whole file bodies into the pane.
        for (const part of partsOf(message.content)) {
          if (part.type !== "tool-result") continue;
          const line = restoredResultLine(part);
          if (line) this.addLine(line);
        }
        continue;
      }
      if (message.role !== "assistant") continue;

      // Restored prose goes through the same markdown renderer as a live
      // response, so a resumed session's `##` headings are headings rather than
      // the characters that spelled them.
      if (typeof message.content === "string") {
        this.addMarkdown(message.content);
        continue;
      }

      for (const part of partsOf(message.content)) {
        // Reasoning only carries `text`; the signature/provider metadata that made
        // it replayable is not persisted, so an empty string is possible.
        if (part.type === "reasoning" && typeof part.text === "string" && part.text.trim()) {
          // `◦` at prose indent, against the `·` that hangs under a call. Both
          // are dimmed, so the glyph and the indent are what tell them apart.
          // Plain, not markdown: this is a log line, not an answer.
          this.addLine(c.dim(`  ◦ ${clipLine(part.text, 100)}`));
          continue;
        }
        if (part.type === "text" && typeof part.text === "string") {
          this.addMarkdown(part.text);
          continue;
        }
        if (part.type === "tool-call" && typeof part.toolName === "string") {
          toolCalls += 1;
          this.addToolCall(toolLabel(part.toolName, part.input), part.input);
        }
      }
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

  private pushMarkdown(text: string): SettableBlock {
    const block = markdownBlock(text);
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
