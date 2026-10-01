/**
 * Interactive alternate-screen host.
 *
 * Replaces the line-oriented readline loop when a TTY is available. The whole
 * point versus the plain renderer is layout: a `ScrollView` owns the transcript
 * and the `Editor` is a sibling pinned below it, so streamed output can never
 * land on the line the user is typing. Submitting while a turn runs steers it
 * instead of queueing a new one.
 */
import {
  Editor,
  Key,
  ScrollView,
  Text,
  TuiAltScreen,
  VStack,
  matchesKey,
  type Terminal,
} from "@earendil-works/pi-tui";
import { getModelOptions } from "../model-catalog.js";
import { pickModel } from "../model-picker.js";
import { resolveModel } from "../model.js";
import { saveLastModel } from "../model-preferences.js";
import { runTurn, type SessionState } from "../session.js";
import { handleSlashCommand, setActiveModel, setupProvider } from "../repl.js";
import { withFileInclusions } from "../context.js";
import { c } from "../render.js";
import { exclusiveCommands, renderCommandHelp, SLASH_COMMANDS } from "../commands.js";

import { TurnOutput } from "./output.js";
import { createClipboardWriter } from "./clipboard.js";
import { createSlashCommandProvider } from "./slash-autocomplete.js";
import { editorTheme } from "./theme.js";

/**
 * Commands that take the terminal over with their own full-screen UI. They must
 * not run mid-turn, and the TUI has to step aside while they do.
 */
const REBUILT = exclusiveCommands();

export type TuiHostOptions = {
  state: SessionState;
  /** Injectable for tests; defaults to the real process terminal. */
  terminal: Terminal;
  /** Called when the user asks to quit, so the caller can exit the process. */
  onQuit?: () => void;
};

/**
 * Everything the TUI switches on, undone in one shot.
 *
 * Mouse reporting is the important one. pi-tui enables 1000/1002/1003/1004/1006
 * and only disables them from `beforeTerminalStop`, which a crash, a kill or a
 * thrown error skips. A terminal left in SGR-mouse mode sends
 * `ESC[<35;col;rowM` on every pointer move, and whatever reads stdin next —
 * usually the shell — prints those parameters as literal text until the tab is
 * closed. Only `reset` clears it.
 */
export const TERMINAL_RESTORE_SEQUENCE =
  "\u001b[?1006l\u001b[?1004l\u001b[?1003l\u001b[?1002l\u001b[?1000l" + // mouse reporting off
  "\u001b[?2004l" + // bracketed paste off
  "\u001b[<u" + // Kitty keyboard protocol off
  "\u001b[?25h" + // cursor on
  "\u001b[?1049l"; // leave the alternate screen

export const startTuiHost = async (options: TuiHostOptions): Promise<void> => {
  const { state, terminal } = options;
  // A verified clipboard writer. Without this the TUI writes an OSC 52 escape
  // and reports "Copied!" whether or not the terminal honoured it.
  const copySelection = createClipboardWriter();
  const screen = new TuiAltScreen(terminal, undefined, undefined, {
    // SGR mouse reports (1003/1006) are what a terminal echoes as
    // "35;107;19M" if they ever leak into a text buffer. Opt out with
    // NAH_NO_MOUSE=1 if your terminal mishandles them; drag-select and wheel
    // scrolling are what you lose, and Cmd+C copy still works.
    mouse: process.env.NAH_NO_MOUSE !== "1",
    copyOnSelect: true,
    copySelection,
  });

  const output = new TurnOutput(() => state.activeFileChanges ?? []);
  // A resumed session is already in `state.messages`; show it, otherwise the
  // pane looks empty and the history reads as lost.
  output.seedHistory(state.messages);
  // Switching sessions mid-run replaces the transcript, not just the state.
  state.onSessionSwitch = (messages) => {
    output.reset();
    output.seedHistory(messages);
    status.setText("");
    refreshPrompt();
    screen.requestRender(true);
  };
  const status = new Text("", 1, 0);
  const editor = new Editor(screen, editorTheme, { paddingX: 1 });

  const scroll = new ScrollView(output, { follow: "end", primary: true });
  const root = new VStack([scroll, status, editor]);
  screen.setLayoutRoot(root);
  screen.setFocus(editor);

  /**
   * Hand the terminal to another full-screen UI and take it back afterwards.
   *
   * The model picker drives stdin itself in raw mode and writes its own
   * alt-screen frames, so the TUI has to release both. `preserveScreen` keeps
   * what we already painted so the picker can overwrite it cleanly.
   */
  const exclusive = async <T>(fn: () => Promise<T>): Promise<T> => {
    screen.stop({ preserveScreen: true });
    try {
      return await fn();
    } finally {
      screen.start();
      screen.setLayoutRoot(root);
      screen.setFocus(editor);
      screen.requestRender(true);
    }
  };

  // `/` opens the modal; the editor auto-triggers on it at the start of a line.
  editor.setAutocompleteProvider(
    createSlashCommandProvider(
      SLASH_COMMANDS.map((command) => ({
        name: command.name,
        description: command.description,
        argumentHint: command.argumentHint,
      })),
    ),
  );

  // Held in an object rather than plain `let` bindings: both are assigned from
  // inside nested callbacks, where TypeScript's narrowing would otherwise pin
  // them to `null` and report every later read as unreachable.
  const run: {
    abort: AbortController | null;
    turn: { steer(text: string): boolean } | null;
    /** True once Ctrl-C has already asked the current turn to stop. */
    abortRequested: boolean;
  } = { abort: null, turn: null, abortRequested: false };
  const deferredCommands: string[] = [];
  let finished: (() => void) | null = null;
  /** A pending tool-approval question, answered by the next editor submission. */
  let approval: { question: string; resolve: (answer: string) => void } | null = null;

  /**
   * Answer an approval prompt from inside the TUI.
   *
   * The readline fallback cannot work here: stdin belongs to the TUI in raw
   * mode, so its question would be painted over and never answered, leaving the
   * tool promise pending and the run wedged on the first mutating call.
   */
  state.setApprovalPrompt?.((question) =>
    new Promise<string>((resolve) => {
      output.addLine(`  ${c.yellow("!")} ${question}`);
      approval = { question, resolve };
      refreshPrompt();
      screen.requestRender(true);
    }),
  );

  /**
   * Slash commands normally write straight to stdout. In the alternate screen
   * that would punch a hole through the layout, so route their output into the
   * transcript instead.
   */
  const sink = {
    write(chunk: string) {
      for (const line of chunk.replace(/\n$/, "").split("\n")) {
        output.addLine(output.hasOpenStream ? `  ${line}` : line);
      }
      screen.requestRender();
      return true;
    },
  } as unknown as NodeJS.WriteStream;

  const setStatus = (text: string) => {
    status.setText(text);
    screen.requestRender();
  };

  const refreshPrompt = () => {
    if (approval) {
      setStatus(c.yellow("  allow?  y  ·  n  ·  a = always this tool  ·  A = always this exact call"));
      return;
    }
    setStatus(
      run.turn
        ? c.dim("  running — type to steer, / for commands")
        : c.dim(`  ${state.model?.spec ?? "no model"} · ${state.cwd}`),
    );
  };

  const startTurn = (input: string) => {
    const files = input.match(/@([^\s]+)/g)?.map((s) => s.slice(1)) ?? [];
    const bare = input.replace(/@[^\s]+/g, "").trim();
    void withFileInclusions(state.cwd, files, bare).then((prompt) => {
      run.abort = new AbortController();
      output.addLine("");
      output.addLine(`${c.magenta("❯")} ${c.bold(prompt)}`);
      const turn = runTurn(state, prompt, { signal: run.abort.signal });
      run.turn = { steer: (text) => turn.steer(text) };
      refreshPrompt();

      void (async () => {
        try {
          for await (const event of turn.events) {
            output.apply(event);
            screen.requestRender();
          }
          await turn.done;
        } catch (error) {
          output.addLine(c.red(`  ${error instanceof Error ? error.message : String(error)}`));
          screen.requestRender();
        } finally {
          run.abort = null;
          run.turn = null;
          run.abortRequested = false;
          await drainDeferred();
          refreshPrompt();
          screen.requestRender();
        }
      })();
    });
  };

  /** `/model` and `/provider` own the terminal; run them with the TUI stepped aside. */
  const runExclusiveCommand = async (input: string): Promise<void> => {
    const name = input.split(" ")[0]!.slice(1);
    const arg = input.slice(name.length + 2).trim();

    if (name === "model") {
      // `/model <provider:model-id>` is a direct switch and needs no picker.
      if (arg) {
        try {
          const model = await resolveModel(arg);
          setActiveModel(state, model);
          await saveLastModel(model.spec);
          output.addLine(c.green(`  model → ${model.spec}`));
        } catch (error) {
          output.addLine(c.red(`  ${arg}: ${error instanceof Error ? error.message : String(error)}`));
        }
        return;
      }
      output.addLine(c.dim("  Loading model catalog…"));
      screen.requestRender(true);
      const selected = await exclusive(async () => pickModel(await getModelOptions()));
      if (!selected) {
        output.addLine(c.dim("  model selection cancelled"));
        return;
      }
      try {
        const model = await resolveModel(selected);
        setActiveModel(state, model);
        await saveLastModel(model.spec);
        output.addLine(c.green(`  model → ${model.spec}`));
      } catch (error) {
        output.addLine(c.red(`  ${selected}: ${error instanceof Error ? error.message : String(error)}`));
      }
      return;
    }

    if (name === "provider") {
      output.addLine(c.dim("  Provider setup…"));
      screen.requestRender(true);
      await exclusive(async () => {
        await setupProvider(state, arg, { write: (chunk: string) => sink.write(chunk) } as never);
      });
    }
  };

  const dispatch = async (input: string): Promise<void> => {
    const name = input.split(" ")[0]!.replace(/^\//, "");
    if (REBUILT.has(name)) {
      await runExclusiveCommand(input);
      return;
    }
    if (input === "/help") {
      for (const line of renderCommandHelp().split("\n")) output.addLine(line);
      return;
    }
    if (await handleSlashCommand(input, state, state.cwd, sink) === "quit") {
      finished?.();
    }
  };

  const drainDeferred = async () => {
    while (deferredCommands.length > 0) {
      await dispatch(deferredCommands.shift()!);
    }
  };

  editor.onSubmit = (raw: string) => {
    const input = raw.trim();
    editor.setText("");
    if (!input) return;

    // A pending approval takes priority: the agent is blocked on this answer.
    if (approval) {
      const answer = input.toLowerCase();
      const pending = approval;
      approval = null;
      output.addLine(
        answer === "a" ? c.dim("  always allowing for this session") : `  ${c.dim("answer:")} ${input}`,
      );
      pending.resolve(answer);
      refreshPrompt();
      screen.requestRender();
      return;
    }

    if (run.turn) {
      if (input.startsWith("/")) {
        const name = input.split(" ")[0]!.replace(/^\//, "");
        if (REBUILT.has(name)) {
          output.addLine(c.dim(`  /${name} needs the terminal to itself — wait for the turn to finish`));
          screen.requestRender();
          return;
        }
        deferredCommands.push(input);
        output.addLine(`  ${c.cyan("↳")} ${c.dim(`${input} queued for when the turn settles`)}`);
        screen.requestRender();
        return;
      }
      if (run.turn.steer(input)) {
        output.addLine(`  ${c.magenta("↳")} ${c.dim("steering:")} ${input}`);
        screen.requestRender();
        return;
      }
      // The run settled between the keystroke and this call; fall through and
      // treat the line as a fresh prompt rather than dropping it.
      run.turn = null;
    }

    if (input === "/quit" || input === "/exit") {
      finished?.();
      return;
    }
    if (input.startsWith("/")) {
      void (async () => {
        try {
          await dispatch(input);
        } catch (error) {
          output.addLine(c.red(`  ${error instanceof Error ? error.message : String(error)}`));
        }
        refreshPrompt();
        screen.requestRender();
      })();
      return;
    }
    startTurn(input);
  };

  // Ctrl-C aborts the turn (or exits when idle); Ctrl-D exits when the editor
  // is empty. Both are handled here because raw mode disables the tty's own
  // ISIG handling, so without this there is no keyboard way out of the TUI.
  //
  // Cmd+C copies the selection when there is one, matching platform convention.
  // Without it there is no keyboard route to the clipboard, since copy-on-select
  // requires a mouse — and plain Ctrl+C must keep aborting.
  screen.addInputListener((data) => {
    if (data === "\x03") {
      // Copy, when the terminal can tell Cmd/Ctrl apart (Kitty keyboard
      // protocol, which pi-tui negotiates). Falls through to abort otherwise.
      if (
        screen.hasActiveSelection() &&
        (matchesKey(data, Key.super("c")) || matchesKey(data, Key.ctrlShift("c")))
      ) {
        void screen.copyActiveSelectionToClipboard();
        return { consume: true };
      }
      // Escalate: the first Ctrl-C stops the turn, a second one exits. Without
      // this there is no keyboard way out while a turn is in flight, because
      // `run.abort` stays set until the turn actually settles.
      if (run.abort && !run.abortRequested) {
        run.abortRequested = true;
        run.abort.abort();
        output.addLine(c.dim("  (turn aborted — press Ctrl+C again to exit)"));
      } else {
        finished?.();
      }
      screen.requestRender();
      return { consume: true };
    }
    if (data === "\x04" && editor.getText().trim().length === 0) {
      finished?.();
      return { consume: true };
    }
    return undefined;
  });

  /**
   * Undo everything the TUI switched on, synchronously and idempotently.
   *
   * Registered on `exit` because a stuck turn, an uncaught throw, or a SIGTERM
   * can all bypass the normal teardown. Skipping it leaves the shell in raw mode
   * inside the alternate screen with bracketed paste, the Kitty keyboard
   * protocol and mouse reporting still active — the terminal looks frozen on the
   * last painted frame and the shell echoes garbage until it is reset.
   */
  const restoreTerminal = (): void => {
    try {
      if (process.stdout.isTTY) {
        process.stdout.write(TERMINAL_RESTORE_SEQUENCE);
      }
      if (process.stdin.isTTY && process.stdin.setRawMode) {
        process.stdin.setRawMode(false);
      }
    } catch {
      // Nothing useful to do while tearing down.
    }
  };
  const onSignal = (): void => {
    restoreTerminal();
    process.exit(0);
  };
  process.once("exit", restoreTerminal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);

  try {
    await new Promise<void>((resolve) => {
      finished = resolve;
      screen.start();
      refreshPrompt();
      screen.requestRender(true);
    });
  } finally {
    if (run.abort) run.abort.abort();
    try {
      screen.stop();
    } finally {
      restoreTerminal();
      process.off("exit", restoreTerminal);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
      options.onQuit?.();
    }
  }
};
