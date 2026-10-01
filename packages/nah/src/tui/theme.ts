/**
 * pi-tui theme.
 *
 * Deliberately wired to the same ANSI helpers the plain renderer uses, so the
 * alternate-screen TUI and the `print`/`json` output look like the same product.
 */
import type { EditorTheme, SelectListTheme } from "@earendil-works/pi-tui";

import { c } from "../render.js";

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (text: string) => c.cyan(text),
  selectedText: (text: string) => c.bold(text),
  description: (text: string) => c.dim(text),
  scrollInfo: (text: string) => c.dim(text),
  noMatch: (text: string) => c.dim(text),
};

export const editorTheme: EditorTheme = {
  // Neutral: the editor should not compete with the transcript for attention.
  borderColor: (text: string) => c.dim(text),
  selectList: selectListTheme,
};
