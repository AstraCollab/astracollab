/**
 * The canonical slash-command registry.
 *
 * `/help` text, the TUI's autocomplete modal, and command dispatch used to be
 * three separate hand-maintained lists that drifted apart. They all read from
 * here now, so a command cannot exist in one and be missing from another.
 */

export type SlashCommandSpec = {
  name: string;
  /** One-line description, shown in `/help` and in the modal. */
  description: string;
  /** Shown after the command name, e.g. `[mode]`. */
  argumentHint?: string;
  /**
   * Commands that hand the terminal to their own full-screen UI. The TUI must
   * release stdin and the alt screen before running these, and refuse them
   * while a turn is streaming.
   */
  exclusive?: boolean;
  /** Accepted when there is no argument; otherwise `/name <arg>` is invalid. */
  argless?: boolean;
};

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  { name: "help", description: "Show this help", argless: true },
  { name: "model", description: "Search and select a model", argumentHint: "[provider:model-id]", exclusive: true },
  { name: "provider", description: "Add or switch provider credentials securely", argumentHint: "[remove <name>]", exclusive: true },
  {
    name: "mode",
    description: "Set ask, yolo, or readonly permissions (ask: y/n, a = allow this tool all session, A = this call only)",
    argumentHint: "[mode]",
  },
  { name: "permissions", description: "ask | yolo | readonly (gates edit/write/bash)", argumentHint: "[mode]" },
  { name: "stats", description: "Tokens used this session", argless: true },
  {
    name: "budget",
    description: "Show or set the per-turn spend ceiling (e.g. /budget 8, /budget auto)",
    argumentHint: "[usd|auto]",
  },
  { name: "task", description: "Show the saved plan and progress", argless: true },
  { name: "task clear", description: "Clear the active plan", argless: true },
  { name: "diff", description: "Show current workspace changes", argless: true },
  { name: "undo", description: "Undo the last turn's workspace changes", argumentHint: "[step]" },
  { name: "clear", description: "Drop the transcript (start fresh)", argless: true },
  { name: "branches", description: "List session branches", argless: true },
  { name: "branch", description: "Fork or switch to a named branch", argumentHint: "<name>" },
  { name: "session", description: "List/new/off sessions for this directory", argumentHint: "list|new|off" },
  { name: "compact", description: "Force transcript compaction (truncate mode)", argless: true },
  { name: "memory", description: "Show Cognitive Memory state (L0-L3 cache, tensions, guardrails)", argless: true },
  { name: "tensions", description: "Show active knowledge tensions", argumentHint: "[resolve <id>]" },
  { name: "quit", description: "Exit and show how to resume", argless: true },
] as const;

export const findCommand = (name: string): SlashCommandSpec | undefined =>
  SLASH_COMMANDS.find((command) => command.name === name);

/** Commands that take over the terminal and cannot run while a turn streams. */
export const exclusiveCommands = (): ReadonlySet<string> =>
  new Set(SLASH_COMMANDS.filter((c) => c.exclusive).map((c) => c.name));

/** Rendered `/help` body, derived from the registry. */
export const renderCommandHelp = (): string => {
  const width = Math.max(...SLASH_COMMANDS.map((c) => c.name.length));
  const rows = SLASH_COMMANDS.map((command) => {
    const label = `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`;
    return `  ${label.padEnd(width + 12)} ${command.description}`;
  });
  return [
    "Slash commands:",
    ...rows,
    "",
    "Steering:",
    "  While a turn is running you can just type — the message is delivered at the",
    "  next step boundary instead of waiting for the turn to finish. A slash command",
    "  typed mid-turn is applied once the turn settles. Ctrl-C still aborts.",
    "",
    "Everything else is sent to the agent. Prefix files with @ to include them.",
  ].join("\n");
};
