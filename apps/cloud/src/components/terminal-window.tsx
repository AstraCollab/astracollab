/**
 * A terminal window, drawn rather than screenshotted.
 *
 * The hero needs to show a real agent session, and the honest way to do that is
 * to write the session out as data instead of embedding a PNG. A screenshot goes
 * stale the moment the CLI changes; this renders at any size, themes with the
 * page, and is selectable and searchable by the reader.
 *
 * Server component with no client JS. The "live" feel comes from a CSS caret
 * and staggered fade-ins, both of which are suppressed under
 * `prefers-reduced-motion` in `globals.css` — so the whole thing costs nothing
 * and works with JavaScript disabled.
 */

/** One line of terminal output. */
type Line =
  | { readonly kind: "input"; readonly text: string }
  /** A tool call, with the argument elided the way a real TUI would. */
  | { readonly kind: "tool"; readonly tool: string; readonly detail: string; readonly result: string }
  /** Free text the agent emitted. */
  | { readonly kind: "say"; readonly text: string }
  /** A failure, rendered in the warning colour. */
  | { readonly kind: "warn"; readonly text: string }
  /** A spacer, so the transcript breathes. */
  | { readonly kind: "gap" }

/** The session shown in the hero. */
const session: readonly Line[] = [
  { kind: "input", text: "find the flaky auth test and fix it" },
  { kind: "gap" },
  { kind: "tool", tool: "grep", detail: "src/**/*.test.ts", result: "3 matches" },
  { kind: "tool", tool: "read", detail: "src/auth/session.test.ts", result: "214 lines" },
  { kind: "say", text: "The third test asserts on a timestamp, so it fails across a second boundary. Mocking the clock instead." },
  { kind: "tool", tool: "edit", detail: "src/auth/session.test.ts", result: "+6 −4" },
  { kind: "tool", tool: "exec", detail: "bun test src/auth", result: "31 passed" },
  { kind: "gap" },
  { kind: "say", text: "Fixed. The suite is green and the change is local to the test." }
]

/** Milliseconds between each line's entrance, in the full-motion case. */
const STAGGER_MS = 260

export function TerminalWindow() {
  return (
    <div className="landing-rule relative overflow-hidden rounded-xl border border-line bg-[var(--surface-inset)]">
      {/* Title bar. The dots are decorative, so they are hidden from AT. */}
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <div className="flex gap-1.5" aria-hidden="true">
          <span className="size-2.5 rounded-full bg-[oklch(0.32_0.008_265)]" />
          <span className="size-2.5 rounded-full bg-[oklch(0.32_0.008_265)]" />
          <span className="size-2.5 rounded-full bg-[oklch(0.32_0.008_265)]" />
        </div>
        <p className="font-mono text-xs text-[var(--ink-faint)]">
          nah — run 4f2a · eu-central-1
        </p>
        <p className="ml-auto flex items-center gap-1.5 font-mono text-xs text-signal-dim">
          <span className="size-1.5 rounded-full bg-signal" aria-hidden="true" />
          running
        </p>
      </div>

      {/*
        The transcript. `aria-label` plus `role="img"` makes this one image to a
        screen reader: the lines are decorative restatements of what the page
        says in prose, and reading them aloud in sequence is noise.
      */}
      <div
        role="img"
        aria-label="A terminal session in which an agent finds a flaky test caused by a real timestamp assertion, edits it to use a mocked clock, and runs the suite to 31 passing."
        className="space-y-1.5 p-5 font-mono text-[13px] leading-relaxed"
      >
        {session.map((line, index) => (
          <TerminalLine key={index} line={line} delay={index * STAGGER_MS} />
        ))}
        <p className="animate-caret text-signal" aria-hidden="true">
          ▍
        </p>
      </div>
    </div>
  )
}

function TerminalLine({ line, delay }: { readonly line: Line; readonly delay: number }) {
  // `both` fill-mode plus an explicit delay: each line starts invisible and
  // holds its final state, so the block never collapses mid-animation.
  const enter = `animate-fade-up [animation-delay:${delay}ms]`

  if (line.kind === "gap") return <div aria-hidden="true" className="h-2" />

  if (line.kind === "input") {
    return (
      <p className={enter}>
        <span className="text-signal" aria-hidden="true">
          ❯{" "}
        </span>
        {line.text}
      </p>
    )
  }

  if (line.kind === "tool") {
    return (
      <p className={enter} style={{ paddingLeft: "1rem" }}>
        <span className="text-[var(--ink-faint)]" aria-hidden="true">
          {line.tool}{" "}
        </span>
        <span className="text-[var(--ink-muted)]">{line.detail}</span>
        <span className="text-[var(--ink-faint)]" aria-hidden="true">
          {"  "}→{" "}
        </span>
        <span className="text-signal-dim">{line.result}</span>
      </p>
    )
  }

  if (line.kind === "warn") {
    return <p className={`${enter} text-[var(--warn)]`}>{line.text}</p>
  }

  return <p className={`${enter} text-[var(--ink-muted)]`}>{line.text}</p>
}
