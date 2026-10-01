/**
 * pi-tui theme.
 *
 * Deliberately wired to the same ANSI helpers the plain renderer uses, so the
 * alternate-screen TUI and the `print`/`json` output look like the same product.
 */
import { Markdown, type DefaultTextStyle, type EditorTheme, type MarkdownTheme, type SelectListTheme } from "@earendil-works/pi-tui";

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

/**
 * How a rendered response looks.
 *
 * Purple is the structure colour: headings, bullets, rules. It is the one hue
 * nothing else in the transcript uses, so a `##` heading is identifiable at a
 * glance from a tool line or a result. `c.magenta` is reserved for the `❯`
 * prompt and `◆` calls, which are UI rather than content.
 */
export const markdownTheme: MarkdownTheme = {
  heading: (text: string) => c.purple(text),
  link: (text: string) => c.cyan(text),
  linkUrl: (text: string) => c.dim(text),
  // Inline code reads as a value, so it gets a colour rather than just emphasis.
  code: (text: string) => c.yellow(text),
  codeBlock: (text: string) => text,
  codeBlockBorder: (text: string) => c.dim(text),
  quote: (text: string) => c.dim(text),
  quoteBorder: (text: string) => c.purple(text),
  hr: (text: string) => c.dim(text),
  listBullet: (text: string) => c.purple(text),
  bold: (text: string) => c.bold(text),
  italic: (text: string) => c.italic(text),
  strikethrough: (text: string) => c.strikethrough(text),
  underline: (text: string) => c.underline(text),
  // The `Markdown` component indents code inside the box; matching the prose
  // indent keeps a fenced block aligned with the paragraph above it.
  codeBlockIndent: "  ",
};

/** Body copy: no colour, so a long response is not a wall of escapes. */
const bodyTextStyle: DefaultTextStyle = {};

/**
 * A response block.
 *
 * The transcript used `Text` for everything, which meant a model that answered
 * with `## Setup` and `- item` had its markdown shown literally. pi-tui already
 * ships a `Markdown` renderer with the same token-level styling the rest of the
 * TUI uses, so the fix is to hand assistant prose to it.
 *
 * `paddingX: 2` indents the whole block under the prompt, matching the two-space
 * indent the plain `Text` blocks used, so a response lines up with the `❯` that
 * asked the question.
 */
export const markdownBlock = (text: string): Markdown =>
  new Markdown(text, 2, 0, markdownTheme, bodyTextStyle, {
    // A streamed fence has not closed yet. Without this a code block collapses
    // and reflows every frame as the closing backticks arrive.
    renderLatex: false,
  });
