/**
 * Slash-command autocomplete for the TUI editor.
 *
 * Deliberately narrow, because the requirements are narrow:
 *
 * - Typing `/` at the start of a line opens the modal; the list filters as you
 *   type (`/mod` narrows to `/model`).
 * - Once a space is typed, the provider returns nothing. `/model ` shows **no**
 *   list — argument completion happens after the command is submitted, not while
 *   it is being typed.
 * - Only the first line of input participates, so the modal cannot reopen
 *   mid-paragraph.
 *
 * pi-tui's `CombinedAutocompleteProvider` would also file-complete on `@`/`#`,
 * and `setAutocompleteTriggerCharacters` can only *add* triggers, never remove
 * them. A purpose-built provider avoids surfacing a popup nobody asked for.
 */
import { fuzzyFilter, type AutocompleteItem, type AutocompleteProvider, type SlashCommand } from "@earendil-works/pi-tui";

export const createSlashCommandProvider = (commands: readonly SlashCommand[]): AutocompleteProvider => {
  const items: AutocompleteItem[] = commands.map((command) => ({
    value: command.name,
    label: command.name,
    description:
      command.argumentHint && command.description
        ? `${command.argumentHint} — ${command.description}`
        : (command.description ?? undefined),
  }));

  return {
    // No `@`/`#` file completion.
    triggerCharacters: [],

    async getSuggestions(lines, cursorLine, cursorCol) {
      if (cursorLine !== 0) return null;
      const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
      if (!before.startsWith("/")) return null;
      // A space means the command name is settled: show nothing until Enter.
      if (/\s/.test(before)) return null;

      const query = before.slice(1);
      const matched = fuzzyFilter(items, query, (item) => item.label);
      if (matched.length === 0) return null;
      return { items: matched, prefix: before };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const currentLine = lines[cursorLine] ?? "";
      // `prefix` is the text being replaced, so keep whatever precedes it and
      // whatever the cursor left after it.
      const before = currentLine.slice(0, Math.max(0, cursorCol - prefix.length));
      const after = currentLine.slice(cursorCol);
      const next = [...lines];
      // The trailing space drops the cursor past the command name so arguments
      // can be typed immediately — and closes the modal, since a space yields
      // no suggestions.
      next[cursorLine] = `${before}/${item.value} ${after}`;
      return {
        lines: next,
        cursorLine,
        cursorCol: before.length + item.value.length + 2,
      };
    },
  };
};
