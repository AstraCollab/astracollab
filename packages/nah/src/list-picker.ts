import * as readline from "node:readline";

import { c } from "./render.js";

/**
 * The full-screen arrow-key picker shared by `/model` and `/session`.
 *
 * It is deliberately the same interaction in both places: the terminal is
 * handed over, ↑/↓ move, typing filters, Enter picks, Esc cancels. Only the
 * rows and the filter differ, so those are the two things a caller supplies.
 */
export type ListPickerOptions<T extends { value: string }> = {
  title: string;
  /** Shown under the title, e.g. "Type to search · ↑/↓ move …". */
  hint?: string;
  items: readonly T[];
  /** Narrow `items` by the typed query. */
  filter: (items: readonly T[], query: string) => readonly T[];
  /** Render one row, already styled, without the leading gutter. */
  format: (item: T) => string;
  /** Plain text the filter searches for one item. Must not hold escape codes. */
  searchText: (item: T) => string;
  /** Placeholder shown in the search line before anything is typed. */
  searchPlaceholder: string;
  /** Shown in place of the rows when the filter matches nothing. */
  emptyText: string;
  /** Overrides the default "n matches · esc to cancel" footer. */
  footer?: (matchCount: number) => string;
};

const fit = (value: string, width: number): string =>
  value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;

/**
 * Show `options.items` and resolve to the chosen item's `value`, or undefined if
 * the user cancelled or there is no TTY to draw on.
 */
export const pickFromList = <T extends { value: string }>(
  options: ListPickerOptions<T>,
): Promise<string | undefined> => {
  const input = process.stdin;
  const out = process.stdout;
  if (!input.isTTY || typeof input.setRawMode !== "function") return Promise.resolve(undefined);

  return new Promise((resolve) => {
    let query = "";
    let selected = 0;
    let matches: readonly T[] = [];
    let settled = false;
    const wasRaw = input.isRaw;

    const draw = () => {
      matches = options.items.length ? options.filter(options.items, query) : [];
      selected = Math.min(selected, Math.max(0, matches.length - 1));
      const width = Math.max(32, out.columns ?? 80);
      const visible = Math.max(3, (out.rows ?? 24) - 8);
      let start = Math.max(0, selected - visible + 1);
      start = Math.min(start, Math.max(0, matches.length - visible));
      const end = Math.min(matches.length, start + visible);

      const lines = [c.bold(options.title)];
      if (options.hint) lines.push(c.dim(options.hint));
      lines.push(
        "",
        `${c.magenta("Search")}  ${query || c.dim(options.searchPlaceholder)}`,
        c.dim("─".repeat(width)),
      );
      if (!matches.length) lines.push(c.dim(`  ${options.emptyText}`));
      for (let index = start; index < end; index += 1) {
        const row = fit(options.format(matches[index]!), width - 2);
        lines.push(index === selected ? `${c.magenta("❯")} ${row}` : `  ${row}`);
      }
      lines.push("");
      const footer = options.footer
        ? options.footer(matches.length)
        : `${matches.length} match${matches.length === 1 ? "" : "es"} · esc to cancel`;
      lines.push(c.dim(fit(footer, width)));
      out.write("\u001b[2J\u001b[H" + lines.join("\n"));
    };

    const onResize = () => draw();
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      input.off("keypress", onKeypress);
      out.off("resize", onResize);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      out.write("\u001b[?25h\u001b[?1049l");
      resolve(value);
    };

    const onKeypress = (sequence: string, key: readline.Key) => {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) return finish();
      if (key.name === "return") {
        const chosen = matches[selected];
        return finish(chosen?.value);
      }
      if (key.name === "up") selected = Math.max(0, selected - 1);
      else if (key.name === "down") selected = Math.min(matches.length - 1, selected + 1);
      else if (key.name === "backspace") {
        query = Array.from(query).slice(0, -1).join("");
        selected = 0;
      } else if (!key.ctrl && !key.meta && sequence && sequence >= " " && sequence !== "\u007f") {
        query += sequence;
        selected = 0;
      }
      draw();
    };

    out.write("\u001b[?1049h\u001b[?25l");
    input.setRawMode(true);
    input.resume();
    readline.emitKeypressEvents(input);
    input.on("keypress", onKeypress);
    out.on("resize", onResize);
    draw();
  });
};