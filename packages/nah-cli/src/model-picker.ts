import * as readline from "node:readline";

import { filterModelOptions, type ModelOption } from "./model-catalog.js";
import { c } from "./render.js";

const fit = (value: string, width: number): string =>
  value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;

export const pickModel = (options: ModelOption[]): Promise<string | undefined> => {
  const input = process.stdin;
  const out = process.stdout;
  if (!input.isTTY || typeof input.setRawMode !== "function") return Promise.resolve(undefined);

  return new Promise((resolve) => {
    let query = "";
    let selected = 0;
    let matches = options;
    let settled = false;
    const wasRaw = input.isRaw;
    const draw = () => {
      matches = options.length ? filterModelOptions(options, query) : [];
      selected = Math.min(selected, Math.max(0, matches.length - 1));
      const width = Math.max(32, out.columns ?? 80);
      const visible = Math.max(3, (out.rows ?? 24) - 8);
      let start = Math.max(0, selected - visible + 1);
      start = Math.min(start, Math.max(0, matches.length - visible));
      const end = Math.min(matches.length, start + visible);
      const lines = [
        c.bold("Select a model"),
        c.dim("Type to search · ↑/↓ move · Enter select · Esc cancel"),
        "",
        `${c.magenta("Search")}  ${query || c.dim("provider, model name, or ID…")}`,
        c.dim("─".repeat(width)),
      ];
      if (!matches.length) lines.push(c.dim("  No matching models"));
      for (let index = start; index < end; index += 1) {
        const option = matches[index]!;
        const label = `${option.provider}:${option.id}  ${c.dim(`— ${option.name}`)}`;
        lines.push(index === selected ? `${c.magenta("❯")} ${fit(label, width - 2)}` : `  ${fit(label, width - 2)}`);
      }
      lines.push("", c.dim(`${matches.length} match${matches.length === 1 ? "" : "es"} · esc to cancel`));
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
        const option = matches[selected];
        return finish(option ? `${option.provider}:${option.id}` : undefined);
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
