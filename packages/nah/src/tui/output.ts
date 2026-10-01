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

import {
  bashCommand,
  c,
  formatFileChange,
  stripAnsi,
  summarizeToolResult,
  toolLabel,
  type RenderableFileChange,
} from "../render.js";
import { formatTokens } from "./sidebar.js";
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

/**
 * How much of a command's output stays in its panel.
 *
 * A shell command's output is unbounded - an install or a test run prints
 * hundreds of lines - and the panel is the transcript now, so it cannot simply
 * hold all of it. Twelve is enough to show a failure's cause or a build's
 * summary; the rest is counted rather than silently dropped.
 */
const PANEL_RESULT_LINES = 12;

/**
 * A command's output, as panel lines.
 *
 * ANSI is stripped: command output is the most common source of colour in the
 * whole transcript, and a panel row cannot carry its own escapes without
 * overflowing its column. Tabs are expanded for the same reason.
 */
const panelResultLines = (output: string, limit = PANEL_RESULT_LINES): string[] => {
  const lines = stripAnsi(output)
    .replace(/\t/g, "  ")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[0]!.trim().length === 0) lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim().length === 0) lines.pop();
  if (lines.length === 0) return [];
  return lines.length <= limit
    ? lines
    : [...lines.slice(0, limit), `… ${lines.length - limit} more lines`];
};

/**
 * A shell command, in full, on its own background block.
 *
 * `toolLabel` clips a command at 50 characters, which is right for a status line
 * and wrong for the transcript: a truncated `npm run` says nothing about which
 * script ran, and a multi-line invocation lost its continuations entirely. The
 * command is the most load-bearing line in a coding session, so it gets the
 * transcript to itself rather than sharing a row with everything else.
 *
 * Continuation lines keep their leading `$` column blank rather than repeating
 * the prompt, so the shape of a multi-line invocation stays readable.
 *
 * **No colour inside these lines.** The panel is padded to the full pane width
 * and then composited into a narrower column beside the sidebar, which clamps
 * the row to the terminal width. A nested SGR sequence makes the row longer in
 * bytes than it is in columns, so the clamp cuts the trailing `\u001b[49m` off
 * mid-escape and the background stays on for the next line - the band appeared
 * one row too low, and the first line looked unhighlighted. Plain text keeps the
 * row's byte length equal to its column count.
 */
const commandBlock = (command: string, count: number): string =>
  [
    ...command.split("\n").map((line, index) => `  ${index === 0 ? "$" : " "} ${line}`),
    ...(count > 1 ? [`  \u00d7${count} identical`] : []),
  ].join("\n");

type MessagePart = Record<string, unknown>;

/**
 * What a block of the transcript is, which decides whether it needs air.
 *
 * Blocks of the same kind stay tight - a tool call and its own result are one
 * unit, a diff is many lines of a single thought. Switching kind gets a blank
 * line, which is what makes a transcript scannable instead of a wall.
 */
export type BlockKind = "user" | "prose" | "tool" | "diff" | "notice";

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

/** The text a `tool-result` part carries, whichever shape it was stored in. */
const resultText = (part: MessagePart): string => {
  const output = part.output as { value?: unknown } | string | undefined;
  return typeof output === "string"
    ? output
    : typeof output?.value === "string"
      ? output.value
      : output === undefined || output === null
        ? ""
        : JSON.stringify(output);
};

/** `· result` for a restored `tool-result`, in the live renderer's shape. */
const restoredResultLine = (part: MessagePart): string => {
  const toolName = typeof part.toolName === "string" ? part.toolName : "tool";
  const summary = summarizeToolResult(toolName, undefined, resultText(part).slice(0, 2000), false);
  return summary.show ? `    ${c.dim("·")} ${c.dim(summary.text)}` : "";
};

/**
 * The one capability the streaming path needs beyond `Component`.
 *
 * `Text` and `Markdown` both expose it, so naming it here keeps the stream typed
 * without a cast at every `setText`.
 */
type SettableBlock = Component & { setText(text: string): void };

/** A panel block, whose fill can be swapped when the call turns out to fail. */
type FillableBlock = SettableBlock & { setCustomBgFn(fn?: (text: string) => string): void };

export class TurnOutput implements Component {
  private readonly blocks: Component[] = [];
  private stream: SettableBlock | null = null;
  private streamBuffer = "";
  private renderedChanges = 0;
  private lastChanges: RenderableFileChange[] | null = null;
  /** Kind of the last rendered block, so the next one can decide on spacing. */
  private lastKind: BlockKind | null = null;
  /**
   * Prompt size of the most recent request, from the last `step-finish`.
   *
   * Kept so the finish line can name both figures. `usage.totalTokens` sums
   * every request in the run, which is throughput and not a context size, so on
   * its own it invites a comparison against a provider's per-request log that
   * can never match.
   */
  private lastRequestTokens = 0;

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
      this.gap("prose");
      this.stream = this.pushMarkdown("");
    }
    this.stream.setText(this.streamBuffer.trimStart());
  }

  /**
   * A standalone line: tool result, notice, diff row, or divider.
   *
   * `kind` groups a multi-line block so its rows are not separated from each
   * other: a 40-line diff is one thought and must not become 40 paragraphs.
   */
  addLine(text: string, kind: BlockKind = "notice"): void {
    this.stream = null;
    this.streamBuffer = "";
    this.gap(kind);
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
    this.gap("prose");
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
    this.lastKind = null;
    this.lastRequestTokens = 0;
  }

  /** Blank line separator. */
  addGap(): void {
    this.stream = null;
    this.streamBuffer = "";
    // Cleared, not set to a kind: the next block must not add a second gap on
    // top of this one.
    this.lastKind = null;
    this.blankLine();
  }

  /**
   * One empty rendered row.
   *
   * Not a `Text`: pi-tui derives a text block's rows from its content and
   * returns *none* for whitespace-only input, so `Text("")` and `Text(" ")`
   * both render to zero lines and a separator built from them is invisible.
   */
  private blankLine(): void {
    this.blocks.push({ render: () => [""], invalidate: () => {} });
  }

  /**
   * Insert a blank line when the kind of block changes.
   *
   * Suppressed at the very top so a transcript does not open on empty space,
   * and suppressed between same-kind blocks so a run of tool calls or diff rows
   * reads as one passage.
   */
  private gap(kind: BlockKind): void {
    if (this.lastKind !== null && this.lastKind !== kind) {
      this.blankLine();
    }
    this.lastKind = kind;
  }

  /** Current run of identical consecutive tool calls, collapsed to one line. */
  private group: {
    label: string;
    key: string;
    count: number;
    block: SettableBlock;
    /** Set for a shell command, whose own result belongs inside the panel. */
    command?: { text: string; block: FillableBlock };
  } | null = null;
  /** Input of the most recent call, so its result can be summarised in context. */
  private groupInput: unknown = null;

  apply(event: HarnessEvent): void {
    switch (event.type) {
      case "text-delta":
        this.appendStream(event.text);
        return;
      case "tool-call":
        this.addToolCall(event.toolName, event.input);
        return;
      case "tool-result": {
        // A command and what it printed are one unit. Leaving the output on a
        // bare line under a filled block made it read as separate narration,
        // and opencode-style panels put the whole exchange in one surface.
        if (this.group?.command) {
          this.appendPanelResult(event.output, event.isError);
          return;
        }
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
          // "tool", not "notice": the result belongs to the call above it.
          this.addLine(`    ${mark} ${event.isError ? c.red(summary.text) : c.dim(summary.text)}`, "tool");
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
        // Optional in practice: the type says it is always present, but a
        // renderer that throws on a malformed event takes the whole pane with
        // it, so the figure is treated as best-effort.
        this.lastRequestTokens = event.request?.totalInputTokens ?? 0;
        this.flushFileChanges();
        return;
      case "finish":
        /**
         * Both figures, because they answer different questions.
         *
         * `totalTokens` is every request the run sent, summed. A provider
         * dashboard shows one request, so a 14-step turn reports ~315k here and
         * ~31k there without either being wrong: each step re-sends the whole
         * transcript. Labelling the sum "tokens" invited exactly that
         * disagreement, so it now says what it is and carries the last
         * request's size next to it.
         */
        this.addLine(
          c.dim(
            `  ${event.reason} · ${formatTokens(event.usage.totalTokens)} processed${
              this.lastRequestTokens > 0
                ? ` · ${formatTokens(this.lastRequestTokens)} in last request`
                : ""
            }${event.usage.estimated ? " (estimated)" : ""}`,
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
        this.addLine(`${c.magenta("❯")} ${userText(message.content)}`, "user");
        continue;
      }
      if (message.role === "tool") {
        // Stored results are their own messages rather than parts of the call,
        // so they are rendered here. Reusing the live summarizer keeps a
        // restored session from dumping whole file bodies into the pane.
        for (const part of partsOf(message.content)) {
          if (part.type !== "tool-result") continue;
          // Same treatment as a live turn: a restored command keeps its output
          // inside its own panel rather than reappearing as a bare line.
          if (this.group?.command) {
            this.appendPanelResult(resultText(part), false);
            continue;
          }
          const line = restoredResultLine(part);
          if (line) this.addLine(line, "tool");
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
          this.addToolCall(part.toolName, part.input);
        }
      }
    }

    const summary = toolCalls > 0 ? ` · ${toolCalls} tool calls` : "";
    this.addLine(c.dim(`  — resumed ${messages.length} earlier messages${summary} —`));
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
      for (const line of formatFileChange(change)) this.addLine(line, "diff");
    }
  }

  /**
   * Record a tool call.
   *
   * Consecutive identical calls collapse into one line with a `×N` count. Six
   * successive bookkeeping calls used to print six near-identical lines, which
   * pushed the actual work out of view.
   */
  private addToolCall(toolName: string, input: unknown): void {
    this.stream = null;
    this.streamBuffer = "";
    this.gap("tool");
    this.groupInput = input;

    const label = toolLabel(toolName, input);
    const command = toolName === "bash" ? bashCommand(input) : null;

    // Keyed on the untruncated command. The display label clips at 50
    // characters, so two genuinely different invocations that share a prefix
    // would otherwise collapse into a single misleading `×2` line.
    const key = command === null ? `${toolName}:${label}` : `bash:${command}`;
    if (this.group && this.group.key === key) {
      this.group.count += 1;
      this.group.block.setText(
        command === null ? toolCallLine(label, this.group.count) : commandBlock(command, this.group.count),
      );
      return;
    }

    const block =
      command === null
        ? this.push(toolCallLine(label, 1))
        : // paddingX/paddingY 0: the block spans the pane edge to edge, so the
          // surface reads as a panel rather than an indented quote.
          this.pushPanel(commandBlock(command, 1));

    this.group = {
      label,
      key,
      count: 1,
      block,
      ...(command === null ? {} : { command: { text: command, block: block as FillableBlock } }),
    };
  }

  /**
   * Fold a command's output into its panel.
   *
   * Rebuilds the whole block rather than appending a line, because a panel is a
   * single `Text`: a separate block for the output would leave a gap that reads
   * as a paragraph break. On failure the surface itself turns red, since a panel
   * row cannot carry coloured text.
   */
  private appendPanelResult(output: string, isError: boolean): void {
    const group = this.group?.command;
    if (!group) return;
    const lines = panelResultLines(output);
    if (lines.length === 0) return;
    const body = lines.map((line) => `    ${line}`).join("\n");
    group.block.setText(`${commandBlock(group.text, this.group?.count ?? 1)}\n${body}`);
    if (isError) group.block.setCustomBgFn((line) => c.backgroundError(line));
  }

  private push(text: string): Text {
    const block = new Text(text, 1, 0);
    this.blocks.push(block);
    return block;
  }

  /**
   * A block painted edge to edge.
   *
   * pi-tui pads each line to the pane width before handing it to `bgFn`, so the
   * function only has to wrap the padded line in the background escapes.
   */
  private pushPanel(text: string): SettableBlock {
    const block = new Text(text, 0, 0, (line) => c.background(line));
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
