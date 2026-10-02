import { describe, expect, it } from "vitest"

import { highlightLines, tokenize, type CodeLanguage } from "@/lib/highlight"

/**
 * The syntax highlighter.
 *
 * The property that matters is the first one: the highlighter emits HTML, so
 * whatever it does to a snippet has to be reversible. If stripping the spans
 * does not return the original characters exactly, then a documentation page has
 * silently changed the code it is showing — and the copy button, which copies
 * the source rather than the markup, would hand the reader something different
 * from what they can see.
 */

const SAMPLES: ReadonlyArray<readonly [CodeLanguage, string]> = [
  ["ts", 'const memory = createClient({ apiKey: process.env.COGNITIVE_MEMORY_KEY! })'],
  [
    "ts",
    '// A comment with "quotes" and <angle brackets>\n' +
      "async function turn(userMessage: string): Promise<string> {\n" +
      "  /* block\n     comment */\n" +
      '  const { context, learning } = await runTurn(memory, { userMessage, run: ask })\n' +
      "  if (context.truncated || learning === null) return context.text\n" +
      "  return `done in ${context.totalTokens} tokens`\n" +
      "}"
  ],
  [
    "sh",
    "# mint a key\n" +
      "curl -X POST localhost:3000/api/v1/turns \\\n" +
      '  -H "Authorization: Bearer $COGNITIVE_MEMORY_KEY" \\\n' +
      "  -H 'content-type: application/json' \\\n" +
      '  -d \'{"userMessage":"deploy ZQ7X4M2K"}\''
  ],
  [
    "json",
    '{\n  "text": "### Memory index",\n  "totalTokens": 1320,\n  "truncated": false,\n  "entries": []\n}'
  ],
  ["text", "plain text, no highlighting at all <not-a-tag> & a stray ampersand"]
]

const strip = (html: string): string =>
  html
    .replace(/<span class="tok-[a-z]+">/g, "")
    .replace(/<\/span>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")

describe("highlight", () => {
  it("returns the source exactly, for every language", () => {
    for (const [language, source] of SAMPLES) {
      const joined = highlightLines(source, language).join("\n")
      expect(strip(joined), `${language}: ${source}`).toBe(source)
    }
  })

  it("escapes markup in the source", () => {
    // A documentation page is a place people paste things they found elsewhere.
    // A snippet containing a tag must render as text, not as an element.
    const [html] = highlightLines('const a = "<script>alert(1)</script>"', "ts")
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
  })

  it("splits into lines, keeping a blank line blank", () => {
    const lines = highlightLines("const a = 1\n\nconst b = 2", "ts")
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe("")
  })

  it("colours TypeScript keywords, strings and calls", () => {
    const tokens = tokenize("await createClient({})", "ts")
    const kindOf = (value: string) => tokens.find((t) => t.value === value)?.kind
    expect(kindOf("await")).toBe("kw")
    expect(kindOf("createClient")).toBe("fn")
    // Punctuation is emitted in runs, so the grouping is checked by contents
    // rather than by equality with one particular slice.
    expect(tokens.some((t) => t.kind === "punc" && t.value.includes("("))).toBe(true)
  })

  it("does not mistake an identifier prefix for a keyword", () => {
    // `iffy` is an identifier. Reading it as `if` + `fy` is the classic way a
    // small highlighter makes a snippet look wrong.
    const tokens = tokenize("const iffy = 1", "ts")
    expect(tokens.find((t) => t.value === "const")?.kind).toBe("kw")
    expect(tokens.find((t) => t.value === "iffy")?.kind).toBe("var")
  })

  it("keeps a multi-line template literal one colour", () => {
    const lines = highlightLines("const a = `one\ntwo\nthree`", "ts")
    // Every line of the literal is a string token, not a fresh line of punc.
    expect(lines.filter((line) => line.includes("tok-str"))).toHaveLength(3)
  })

  it("colours a JSON key differently from its value", () => {
    const tokens = tokenize('{"truncated": false}', "json")
    expect(tokens.find((t) => t.value === '"truncated"')?.kind).toBe("key")
    expect(tokens.find((t) => t.value === "false")?.kind).toBe("bool")
  })

  it("colours the command and the flags in a shell line", () => {
    const tokens = tokenize("curl -X POST https://example.test", "sh")
    expect(tokens.find((t) => t.value === "curl")?.kind).toBe("cmd")
    expect(tokens.find((t) => t.value === "-X")?.kind).toBe("flag")
    // The verb after -X is the interesting one, so it is not left as a word.
    expect(tokens.find((t) => t.value === "POST")?.kind).toBe("kw")
  })

  it("leaves text unhighlighted", () => {
    expect(tokenize("anything", "text")).toEqual([{ kind: "punc", value: "anything" }])
  })
})
