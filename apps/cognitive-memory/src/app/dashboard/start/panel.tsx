"use client"

import { useState } from "react"

import { Code, CopyButton, PageHeader, Panel, Table, Td, Th } from "../ui"

/**
 * Wiring an agent up, and trying it before you commit to it.
 *
 * The snippets are the point of the page: most of the time something does not
 * work because a scope is missing or a key was revoked, and both are visible in
 * one request. So the tester sends real calls with a key you paste, against the
 * endpoint you pick, and shows the exact status and body — including the 403 that
 * names the scope you forgot.
 *
 * The pasted key is held in component state for the life of the tab and never
 * written anywhere: no storage, no cookie, no analytics event. It is the same
 * credential an agent holds, and the dashboard is not the place to start keeping
 * copies of those.
 */

const BASE = "/api/v1"

interface Call {
  method: "GET" | "POST"
  path: string
  scope: string
  purpose: string
  body?: string
}

const CALLS: ReadonlyArray<Call> = [
  {
    method: "POST",
    path: "/memories",
    scope: "memories:write",
    purpose: "Store facts the agent should keep. Restatements are folded in, not duplicated.",
    body: `{
  "items": [
    {
      "content": "The staging database is db-stg-01.internal:5432",
      "domains": ["database"]
    }
  ]
}`
  },
  {
    method: "POST",
    path: "/recall",
    scope: "memories:read",
    purpose: "Rank everything held against a query. Deterministic; no model in the path.",
    body: `{
  "query": "where is the staging database",
  "limit": 5
}`
  },
  {
    method: "POST",
    path: "/context",
    scope: "memories:read",
    purpose: "The block to prepend to a system prompt. Called once per turn, before the model runs.",
    body: `{
  "userMessage": "deploy ZQ7X4M2K to the internal staging host"
}`
  },
  {
    method: "POST",
    path: "/turns",
    scope: "memories:write",
    purpose: "Learn from a finished exchange. Post it after the reply streams.",
    body: `{
  "userMessage": "the staging host is db-stg-01.internal, use port 5433 not 5432",
  "assistantResponse": "Noted — staging runs on 5433."
}`
  },
  {
    method: "POST",
    path: "/self-model/outcome",
    scope: "memories:write",
    purpose: "Record how a domain went, which is what turns a failure into a guardrail.",
    body: `{
  "domain": "database",
  "success": false,
  "failurePattern": "migrated without a backup"
}`
  },
  {
    method: "GET",
    path: "/stats",
    scope: "stats:read",
    purpose: "Usage only, no memory contents. Safe for a monitoring job."
  },
  {
    method: "GET",
    path: "/health",
    scope: "none",
    purpose: "Liveness, plus any environment value that was unusable. Unauthenticated."
  }
]

const SDK = `import { createClient, runTurn } from "@astracollab/cogmem"

const memory = createClient({
  apiKey: process.env.COGNITIVE_MEMORY_KEY!,
  baseUrl: "http://localhost:3000"
})

// Before the model runs, and after it finishes.
const { context, learning } = await runTurn(
  memory,
  {
    userMessage,
    // Anything this callback returns is what the model sees.
    run: (context) => callYourModel(context, userMessage)
  },
  { domain: "database" }
)

console.log(context.text)          // exactly what was injected
console.log(learning.counts)      // stored / merged / rejected, never silently`

const curl = (path: string, body?: string): string =>
  [
    `curl -X ${body === undefined ? "GET" : "POST"} localhost:3000${BASE}${path} \\`,
    `  -H "Authorization: Bearer $COGNITIVE_MEMORY_KEY" \\`,
    ...(body === undefined
      ? []
      : [
          `  -H "content-type: application/json" \\`,
          // Single-line, because the snippet has to survive being pasted into a
          // shell: a multi-line `-d '...'` with newlines is valid JSON but not
          // valid curl.
          `  -d '${body.replace(/\s*\n\s*/g, " ").trim()}'`
        ])
  ].join("\n")

export function StartPanel() {
  const [selected, setSelected] = useState(CALLS[2]!)
  const [body, setBody] = useState(selected.body ?? "")
  const [key, setKey] = useState("")
  const [response, setResponse] = useState<string | null>(null)
  const [status, setStatus] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const send = async () => {
    if (key.trim() === "") return
    setBusy(true)
    setResponse(null)
    setStatus(null)
    try {
      const result = await fetch(`${BASE}${selected.path}`, {
        method: selected.method,
        headers: {
          authorization: `Bearer ${key.trim()}`,
          ...(body.trim() === "" ? {} : { "content-type": "application/json" })
        },
        ...(selected.method === "GET" || body.trim() === "" ? {} : { body })
      })
      setStatus(result.status)
      const text = await result.text()
      setResponse(
        (() => {
          try {
            return JSON.stringify(JSON.parse(text), null, 2)
          } catch {
            return text
          }
        })()
      )
    } catch (cause) {
      setStatus(0)
      setResponse(cause instanceof Error ? cause.message : "Request failed.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Get started"
        description={
          <>
            The service is a credentialed storage layer: one call before the model runs,
            one after. Everything below is copy-pasteable, and the tester at the bottom
            sends real requests so you can see exactly what comes back.
          </>
        }
      />

      <Panel title="1 · Install the SDK" hint="Or skip it and use the HTTP API directly — it is the same contract.">
        <Code>{`pnpm add @astracollab/cogmem`}</Code>
      </Panel>

      <Panel
        title="2 · Point it at this service"
        hint="runTurn builds the context block, runs your callback with it, learns from the finished exchange, and records how the domain went — in that order."
      >
        <Code>{SDK}</Code>
        <div className="mt-2 flex justify-end">
          <CopyButton value={SDK} />
        </div>
      </Panel>

      <Panel
        title="3 · Try the HTTP API"
        hint="Authorization: Bearer, or x-cognitive-memory-key. Anything without a key gets a 401 naming the header it wanted."
      >
        <ul className="space-y-2">
          {CALLS.map((call) => (
            <li key={call.path} className="rounded-lg border border-white/[0.06] bg-black/20">
              <button
                type="button"
                onClick={() => {
                  setSelected(call)
                  setBody(call.body ?? "")
                  setResponse(null)
                  setStatus(null)
                }}
                className="flex w-full flex-wrap items-baseline gap-2 px-3 py-2 text-left"
              >
                <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[9px] text-zinc-400">
                  {call.method}
                </span>
                <code className="font-mono text-[11px] text-violet-200">
                  {BASE}
                  {call.path}
                </code>
                <span className="font-mono text-[9px] text-zinc-700">{call.scope}</span>
                <span className="w-full text-[11px] leading-4 text-zinc-600">{call.purpose}</span>
              </button>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Endpoint reference" hint="What each call is for and what it needs.">
        <Table
          head={
            <>
              <Th>endpoint</Th>
              <Th>scope</Th>
              <Th>purpose</Th>
            </>
          }
        >
          {CALLS.map((call) => (
            <tr key={call.path}>
              <Td className="whitespace-nowrap">
                <span className="font-mono text-[10px] text-zinc-700">{call.method}</span>{" "}
                <code className="font-mono text-[11px] text-zinc-300">
                  {BASE}
                  {call.path}
                </code>
              </Td>
              <Td className="font-mono text-[10px] text-zinc-500">{call.scope}</Td>
              <Td className="text-[11px] leading-4 text-zinc-500">{call.purpose}</Td>
            </tr>
          ))}
        </Table>
      </Panel>

      <Panel
        title="Live test"
        hint="Paste a key and send a real request. It is held in this tab's memory only — never stored, never sent anywhere but this service."
      >
        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
              api key
            </span>
            <div className="flex flex-wrap gap-2">
              <input
                type="password"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="cmi_dev_…"
                autoComplete="off"
                className="secret min-w-0 flex-1 rounded-lg px-3 py-2 font-mono text-[11px] text-violet-100 outline-none"
              />
              <button
                type="button"
                disabled={busy || key.trim() === ""}
                onClick={() => void send()}
                className="rounded-lg bg-violet-500 px-3.5 py-2 text-[13px] font-medium text-white transition hover:bg-violet-400 disabled:opacity-40"
              >
                {busy ? "Sending…" : `Send ${selected.method} ${selected.path}`}
              </button>
            </div>
          </label>

          {selected.body !== undefined && (
            <label className="block space-y-1.5">
              <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
                request body
              </span>
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                rows={5}
                className="w-full resize-y rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-[11px] leading-5 text-zinc-300 outline-none transition focus:border-violet-400/50"
              />
            </label>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
                the same thing in curl
              </span>
              <CopyButton value={curl(selected.path, selected.method === "POST" ? body : undefined)} />
            </div>
            <Code>{curl(selected.path, selected.method === "POST" ? body : undefined)}</Code>
          </div>

          {(response !== null || status !== null) && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
                  response
                </span>
                {status !== null && (
                  <span
                    className={`font-mono text-[10px] ${
                      status >= 200 && status < 300 ? "text-emerald-300" : "text-red-300"
                    }`}
                  >
                    {status === 0 ? "no response" : status}
                    {status === 401 && " · 401 means the key is wrong, revoked or expired"}
                    {status === 403 && " · 403 means the key lacks the scope for this call"}
                  </span>
                )}
              </div>
              <Code>{response ?? ""}</Code>
            </div>
          )}
        </div>
      </Panel>
    </div>
  )
}