import type { ReactNode } from "react"

import { CodeBlock } from "./code-block"
import { CodeTabs } from "./code-tabs"

/**
 * One endpoint, in full.
 *
 * A table row tells you an endpoint exists. It does not tell you what to put in
 * the body or what comes back, and those are the two things you need in order to
 * call it — so the ones worth calling get the request and the real response
 * shape side by side, in TypeScript and in curl.
 *
 * The scope is on the card rather than in a separate column because it is the
 * thing you get wrong: the request looks identical whether or not the key holds
 * it, and the only symptom is a 403.
 */
export function Endpoint({
  method,
  path,
  scope,
  does,
  ts,
  curl,
  response,
  note
}: {
  method: "GET" | "POST" | "PATCH" | "DELETE"
  path: string
  scope: string
  does: ReactNode
  /** The SDK call. */
  ts?: string
  /** The raw HTTP equivalent. */
  curl?: string
  /** A trimmed but real response body, with the fields that matter. */
  response?: string
  /** The trap. Rendered under the tabs, where it is read. */
  note?: ReactNode
}) {
  return (
    <section className="scroll-mt-20 rounded-xl border border-white/[0.08] bg-white/[0.015]">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-white/[0.06] px-4 py-3">
        <MethodBadge method={method} />
        <code className="font-mono text-[12px] text-zinc-200">{path}</code>
        <code className="ml-auto rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
          {scope}
        </code>
      </header>

      <div className="px-4 pt-3.5 text-[13px] leading-6 text-zinc-400">{does}</div>

      <div className="px-4 pb-4">
        {ts || curl || response ? (
          <CodeTabs
            tabs={[
              ...(ts ? [{ label: "TypeScript", node: <CodeBlock language="ts">{ts}</CodeBlock> }] : []),
              ...(curl ? [{ label: "Request", node: <CodeBlock language="sh">{curl}</CodeBlock> }] : []),
              ...(response
                ? [{ label: "Response", node: <CodeBlock language="json">{response}</CodeBlock> }]
                : [])
            ]}
          />
        ) : null}
        {note ? (
          <p className="mt-1 border-l-2 border-amber-400/40 pl-3 text-xs leading-5 text-zinc-500">
            {note}
          </p>
        ) : null}
      </div>
    </section>
  )
}

/**
 * Coloured by method, because "which verb is this" is the first thing your eye
 * needs and four identical grey labels make it a reading task instead of a
 * recognition one. Restrained tints — this is a label, not a status.
 */
export function MethodBadge({ method }: { method: EndpointMethod }) {
  const tone: Record<EndpointMethod, string> = {
    GET: "border-white/[0.10] bg-white/[0.04] text-zinc-400",
    POST: "border-violet-400/25 bg-violet-400/[0.08] text-violet-200",
    PATCH: "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-200",
    DELETE: "border-rose-400/25 bg-rose-400/[0.08] text-rose-200"
  }
  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-mono text-[9px] tracking-widest ${tone[method]}`}
    >
      {method}
    </span>
  )
}

type EndpointMethod = "GET" | "POST" | "PATCH" | "DELETE"
