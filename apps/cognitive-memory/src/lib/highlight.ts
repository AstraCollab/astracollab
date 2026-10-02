/**
 * Syntax highlighting, in one file, with no dependencies.
 *
 * A documentation page is read by people scanning for the one line they need,
 * and colour is most of what makes a line findable. It is also the single
 * cheapest upgrade available to a reference — but it has to run on the server,
 * because highlighting that ships a parser to the browser to colour text the
 * server could have coloured is a bad trade on a docs site.
 *
 * So: tokenise here, emit spans, and let the palette live in `globals.css`.
 * A stock highlighter was not an option anyway — the theme here is violet on
 * near-black, deliberately restrained, and every bundled theme would bring its
 * own opinions about saturation.
 *
 * The tokenizer is a single ordered alternation per language, scanned left to
 * right. It is not a parser: it makes no attempt to understand the program, only
 * to find the next interesting run of characters. That is enough to colour a
 * snippet, and it fails safe — anything it does not recognise is emitted as
 * plain text, so an unrecognised token is never dropped or mangled.
 */

export type CodeLanguage = "ts" | "sh" | "json" | "text"

export type TokenKind =
  | "com"
  | "str"
  | "kw"
  | "num"
  | "fn"
  | "punc"
  | "var"
  | "flag"
  | "cmd"
  | "key"
  | "bool"
  | "prop"

export interface Token {
  readonly kind: TokenKind
  readonly value: string
}

const TS_KEYWORDS = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const",
  "continue", "declare", "default", "delete", "do", "else", "enum", "export",
  "extends", "finally", "for", "from", "function", "get", "if", "implements",
  "import", "in", "instanceof", "interface", "is", "keyof", "let", "new", "of",
  "override", "private", "protected", "public", "readonly", "return", "satisfies",
  "set", "static", "switch", "this", "throw", "try", "type", "typeof", "var",
  "void", "while", "yield"
])

const TS_LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"])

const SH_KEYWORDS = new Set([
  "if", "then", "else", "fi", "for", "while", "do", "done", "case", "esac",
  "function", "return", "export", "local", "set", "echo", "cd", "source"
])

/** Shell commands worth colouring; everything else at the start of a line is too. */
const SH_COMMANDS = new Set([
  "curl", "npm", "pnpm", "node", "bun", "deno", "npx", "git", "docker", "python",
  "python3", "pip", "sh", "bash", "zsh", "make", "cargo", "go", "psql", "sqlite3",
  "openssl", "cp", "mv", "rm", "mkdir", "ls", "cat", "grep", "sed", "awk", "env",
  "export", "exit", "kill", "ps", "open", "sudo", "jq", "which", "printf", "echo"
])

const HTTP_METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"])

/**
 * Escape, then wrap.
 *
 * The order matters and is the whole security property of this file: a snippet
 * is author-controlled, but a documentation page is a place people paste things
 * they found elsewhere, and this string ends up in `dangerouslySetInnerHTML`.
 */
const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const span = (kind: TokenKind, value: string): string =>
  `<span class="tok-${kind}">${escapeHtml(value)}</span>`

/** The last token that is not whitespace, for lookbacks across a gap. */
const lastSignificant = (tokens: readonly Token[]): Token | undefined => {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]
    if (token !== undefined && token.value.trim() !== "") return token
  }
  return undefined
}

/* -------------------------------------------------------------------------- */
/* Scanners                                                                   */
/* -------------------------------------------------------------------------- */

const scanTypeScript = (source: string): Token[] => {
  const tokens: Token[] = []
  // A token boundary that is not a word character, so `iffy` is an identifier
  // and not the keyword `if` followed by `fy`.
  const boundary = "(?![A-Za-z0-9_$])"
  const pattern = new RegExp(
    [
      /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.source,
      /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/.source,
      /(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/.source,
      /([A-Za-z_$][\w$]*)/.source,
      /([{}()[\].,;:?!<>=+\-*/%&|^~]+)/.source
    ].join("|"),
    "g"
  )

  let cursor = 0
  for (const match of source.matchAll(pattern)) {
    const start = match.index
    if (start > cursor) tokens.push({ kind: "punc", value: source.slice(cursor, start) })
    const value = match[0]

    if (match[1] !== undefined) tokens.push({ kind: "com", value })
    else if (match[2] !== undefined) tokens.push({ kind: "str", value })
    else if (match[3] !== undefined) tokens.push({ kind: "num", value })
    else if (match[4] !== undefined) {
      // A call is a function; a bare word is a keyword, a literal, or neither.
      const after = source.slice(start + value.length)
      const isCall = new RegExp(`^\\s*\\(${boundary}`).test(after)
      if (TS_LITERALS.has(value)) tokens.push({ kind: "bool", value })
      else if (TS_KEYWORDS.has(value)) tokens.push({ kind: "kw", value })
      else if (isCall) tokens.push({ kind: "fn", value })
      else if (/^[A-Z]/.test(value)) tokens.push({ kind: "prop", value })
      else tokens.push({ kind: "var", value })
    } else tokens.push({ kind: "punc", value })

    cursor = start + value.length
  }
  if (cursor < source.length) tokens.push({ kind: "punc", value: source.slice(cursor) })
  return tokens
}

const scanShell = (source: string): Token[] => {
  const tokens: Token[] = []
  const pattern = new RegExp(
    [
      /(#[^\n]*)/.source,
      /("(?:[^"\\]|\\.)*"|'[^']*')/.source,
      /(\$\{[^}]*\}|\$[A-Za-z_][\w]*|\$\{[^}]*:-[^}]*\})/.source,
      /(--?[A-Za-z][\w-]*)/.source,
      /([A-Za-z_][\w./-]*)/.source,
      /(\b\d+\b)/.source,
      /([{}()[\]=<>|&;:,]+)/.source
    ].join("|"),
    "g"
  )

  let cursor = 0
  let atLineStart = true
  for (const match of source.matchAll(pattern)) {
    const start = match.index
    if (start > cursor) {
      const gap = source.slice(cursor, start)
      tokens.push({ kind: "punc", value: gap })
      if (gap.includes("\n")) atLineStart = true
    }
    const value = match[0]

    if (match[1] !== undefined) tokens.push({ kind: "com", value })
    else if (match[2] !== undefined) tokens.push({ kind: "str", value })
    else if (match[3] !== undefined) tokens.push({ kind: "var", value })
    else if (match[4] !== undefined) tokens.push({ kind: "flag", value })
    else if (match[6] !== undefined) tokens.push({ kind: "num", value })
    else if (match[5] !== undefined) {
      // The first word on a line is the command; after a verb flag it is the HTTP
      // method. The lookback has to skip whitespace, because the gap between
      // `-X` and `POST` is emitted as its own token and stopping at it would
      // leave the method unrecognised in every curl example on the site.
      const previous = lastSignificant(tokens)
      if (atLineStart) {
        tokens.push({ kind: SH_COMMANDS.has(value) ? "cmd" : "kw", value })
        atLineStart = false
      } else if (previous?.kind === "flag" && HTTP_METHODS.has(value.toUpperCase())) {
        tokens.push({ kind: "kw", value: value.toUpperCase() })
      } else if (SH_KEYWORDS.has(value)) tokens.push({ kind: "kw", value })
      else tokens.push({ kind: "var", value })
    } else tokens.push({ kind: "punc", value })

    cursor = start + value.length
  }
  if (cursor < source.length) tokens.push({ kind: "punc", value: source.slice(cursor) })
  return tokens
}

const scanJson = (source: string): Token[] => {
  const tokens: Token[] = []
  const pattern = new RegExp(
    [
      /("(?:[^"\\]|\\.)*")(?=\s*:)/.source,
      /("(?:[^"\\]|\\.)*")/.source,
      /(\b(?:true|false|null)\b)/.source,
      /(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/.source,
      /([{}[\],:]+)/.source
    ].join("|"),
    "g"
  )

  let cursor = 0
  for (const match of source.matchAll(pattern)) {
    const start = match.index
    if (start > cursor) tokens.push({ kind: "punc", value: source.slice(cursor, start) })
    if (match[1] !== undefined) tokens.push({ kind: "key", value: match[0] })
    else if (match[2] !== undefined) tokens.push({ kind: "str", value: match[0] })
    else if (match[3] !== undefined) tokens.push({ kind: "bool", value: match[0] })
    else if (match[4] !== undefined) tokens.push({ kind: "num", value: match[0] })
    else tokens.push({ kind: "punc", value: match[0] })
    cursor = start + match[0].length
  }
  if (cursor < source.length) tokens.push({ kind: "punc", value: source.slice(cursor) })
  return tokens
}

const SCANNERS: Record<Exclude<CodeLanguage, "text">, (source: string) => Token[]> = {
  ts: scanTypeScript,
  sh: scanShell,
  json: scanJson
}

/* -------------------------------------------------------------------------- */
/* Public                                                                     */
/* -------------------------------------------------------------------------- */

export const tokenize = (source: string, language: CodeLanguage): readonly Token[] =>
  language === "text" ? [{ kind: "punc", value: source }] : SCANNERS[language](source)

/**
 * Highlight to HTML, one entry per line.
 *
 * Per line rather than one string, because the caller needs to emphasise a line
 * and a gutter-free block still has to be able to point at one. Tokens are split
 * on newlines after the fact rather than the source being tokenized line by line,
 * so a template literal or a block comment spanning several lines keeps its
 * colour instead of restarting on every line.
 */
export const highlightLines = (source: string, language: CodeLanguage): string[] => {
  const tokens = tokenize(source, language)
  const lines: string[] = [""]

  for (const token of tokens) {
    const pieces = token.value.split("\n")
    pieces.forEach((piece, index) => {
      if (index > 0) lines.push("")
      if (piece !== "") lines[lines.length - 1] += span(token.kind, piece)
    })
  }
  return lines
}
