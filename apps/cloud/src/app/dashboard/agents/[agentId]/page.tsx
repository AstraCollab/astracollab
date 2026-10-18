import Link from "next/link"
import { notFound } from "next/navigation"
import { and, desc, eq } from "drizzle-orm"

import {
  cancelRunAction,
  launchRunAction,
  toggleAgentAction,
  updateAgentRuntimeAction
} from "@/app/dashboard/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { runTone } from "@/components/dashboard/status"
import { getDb } from "@/server/db/client"
import { agents, runs, sandboxes } from "@/server/db/schema"
import { requireOrganization } from "@/server/session"

export const metadata = {
  title: "Agent — Nah Cloud"
}

/**
 * One agent: what it is, and the run history that proves it works.
 *
 * The start-a-run form is the reason this page exists. Everything else on it —
 * the config, the template, the ceilings — is a reference, but a reference nobody
 * looks at. So the prompt box is first and the knobs are below it.
 *
 * A paused agent still accepts a run form submission, deliberately: `createRunAction`
 * does not check `paused`, and the run lands `queued` against a sandbox that will
 * not be allocated. Pausing is about whether *ongoing* work continues, not a
 * read-only lock, and hiding the form would suggest the latter.
 */
export default async function AgentPage({
  params
}: {
  readonly params: Promise<{ agentId: string }>
}) {
  const viewer = await requireOrganization()
  const db = getDb()
  const { agentId } = await params

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.organizationId, viewer.organizationId)))
    .limit(1)

  // `notFound` rather than a 403: the row either belongs to this org or does not
  // exist as far as this session is concerned, and telling a user which of those
  // it was leaks the existence of another tenant's agent id.
  if (!agent) notFound()

  const runHistory = await db
    .select({
      id: runs.id,
      status: runs.status,
      prompt: runs.prompt,
      createdAt: runs.createdAt
    })
    .from(runs)
    .where(and(eq(runs.agentId, agent.id), eq(runs.organizationId, viewer.organizationId)))
    .orderBy(desc(runs.createdAt))
    .limit(20)

  const liveSandbox = await db
    .select({ id: sandboxes.id, status: sandboxes.status, runtimeUrl: sandboxes.runtimeUrl })
    .from(sandboxes)
    .where(
      and(
        eq(sandboxes.agentId, agent.id),
        eq(sandboxes.organizationId, viewer.organizationId),
        eq(sandboxes.status, "running")
      )
    )
    .limit(1)

  const config = agent.config
  const configRows: readonly (readonly [string, string])[] = [
    ["template", agent.template],
    ["model", config.model ?? "default"],
    ["cpu", config.cpu ? String(config.cpu) : "default"],
    ["memory", config.memoryMb ? `${config.memoryMb} MB` : "default"],
    ["timeout", config.timeoutMs ? `${Math.round(config.timeoutMs / 1000)}s` : "default"],
    // `noEnv` reads as a *protection*, so it is shown as what it prevents rather
    // than as a boolean. Inverted booleans are the ones people misread.
    ["provider env", config.noEnv === false ? "injected" : "not injected"]
  ]

  // Env keys only — the values are secrets and never leave the server. The form
  // is submitted as a full replacement set, so an empty value means "keep the
  // stored secret" and omitting a line means "delete that key".
  const envLines = Object.keys(config.env ?? {})
    .map((key) => `${key}=`)
    .join("\n")

  return (
    <div className="space-y-10">
      <header className="space-y-3">
        <Link
          href="/dashboard/agents"
          className="font-mono-tech text-xs text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
        >
          ← Agents
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="tracking-display text-3xl font-semibold">{agent.name}</h1>
          {agent.paused ? <Badge tone="warn">paused</Badge> : null}
        </div>
        <p className="font-mono-tech text-sm text-[var(--ink-faint)]">{agent.repository}</p>
        {/* The description is the answer to "what does this agent do", so it sits
            directly under the name where the question is asked. */}
        {agent.instructions ? (
          <p className="max-w-2xl text-sm leading-relaxed text-[var(--ink-muted)]">
            {agent.instructions}
          </p>
        ) : null}
        <div className="pt-1">
          <Link
            href={`/dashboard/agents/${agent.id}/chat`}
            className="inline-flex items-center gap-2 rounded-[0.75rem] border border-signal/40 bg-signal/10 px-3 py-1.5 text-sm text-signal transition-colors hover:bg-signal/15"
          >
            Chat with this agent
          </Link>
        </div>
      </header>

      <section className="glass rounded-[0.75rem] p-6">
        <h2 className="text-lg font-medium">Start a run</h2>
        <form action={launchRunAction} className="mt-4 space-y-4">
          {/* Hidden rather than defaulted: the action reads this id straight back
              out, and a visible editable field is an invitation to point a run at
              an agent the form was not rendered for. */}
          <input type="hidden" name="agentId" value={agent.id} />
          <div className="space-y-2">
            <label htmlFor="prompt" className="eyebrow block">
              Prompt
            </label>
            <Textarea
              id="prompt"
              name="prompt"
              required
              rows={4}
              placeholder="Add a test for the token refresh path and make it pass."
            />
          </div>
          <Button
            type="submit"
            className="rounded-[0.75rem] border-signal bg-signal text-[#09090b] hover:bg-signal/90"
          >
            Start run
          </Button>
        </form>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="elev-1 rounded-[0.75rem] border border-line bg-[var(--surface-raised)] p-5">
          <h2 className="text-lg font-medium">Configuration</h2>
          <dl className="mt-4 flex flex-col gap-2">
            {configRows.map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-4">
                <dt className="eyebrow">{label}</dt>
                <dd className="font-mono-tech truncate text-xs text-[var(--ink-muted)]">
                  {value}
                </dd>
              </div>
            ))}
          </dl>

          <form action={toggleAgentAction} className="mt-5">
            <input type="hidden" name="agentId" value={agent.id} />
            <Button type="submit" variant="outline" className="rounded-[0.75rem]">
              {agent.paused ? "Resume agent" : "Pause agent"}
            </Button>
          </form>
        </div>

        <div className="elev-1 rounded-[0.75rem] border border-line bg-[var(--surface-raised)] p-5">
          <h2 className="text-lg font-medium">Runtime</h2>
          <form action={updateAgentRuntimeAction} className="mt-4 space-y-3">
            <input type="hidden" name="agentId" value={agent.id} />
            <div className="space-y-1">
              <label htmlFor="model" className="eyebrow block">
                Model (provider:model)
              </label>
              <input
                id="model"
                name="model"
                defaultValue={typeof config.model === "string" ? config.model : ""}
                className="w-full rounded-[0.75rem] border border-line bg-[var(--surface-inset)] px-3 py-1.5 font-mono-tech text-xs text-[var(--ink)] outline-none focus-visible:ring-2 focus-visible:ring-signal/40"
                placeholder="anthropic:claude-sonnet-4-5"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="env" className="eyebrow block">
                Environment — KEY=value, one per line. Values are never shown.
              </label>
              <Textarea
                id="env"
                name="env"
                rows={4}
                defaultValue={envLines}
                className="font-mono-tech text-xs"
                placeholder="ANTHROPIC_API_KEY="
              />
            </div>
            <Button type="submit" variant="outline" className="rounded-[0.75rem]">
              Save runtime
            </Button>
          </form>
        </div>

        <div className="elev-1 rounded-[0.75rem] border border-line bg-[var(--surface-raised)] p-5">
          <h2 className="text-lg font-medium">Sandbox</h2>
          {liveSandbox[0] ? (
            <div className="mt-4 space-y-2">
              <Badge tone={liveSandbox[0].status === "running" ? "busy" : "neutral"}>
                {liveSandbox[0].status}
              </Badge>
              <p className="font-mono-tech break-all text-xs text-[var(--ink-muted)]">
                {liveSandbox[0].runtimeUrl ?? "not yet reachable"}
              </p>
            </div>
          ) : (
            <p className="mt-4 text-sm text-[var(--ink-muted)]">
              No live sandbox. One is allocated when a run starts.
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-medium">Recent runs</h2>
        {runHistory.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--ink-muted)]">No runs yet.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {runHistory.map((run) => (
              <li
                key={run.id}
                className="flex items-center gap-4 rounded-[0.75rem] border border-line bg-[var(--surface-raised)] px-4 py-3"
              >
                <Link
                  href={`/dashboard/runs/${run.id}`}
                  className="min-w-0 flex-1 truncate text-sm transition-colors hover:text-signal"
                >
                  {run.prompt}
                </Link>
                <Badge tone={runTone(run.status)}>{run.status}</Badge>
                {run.status === "running" ? (
                  <form action={cancelRunAction}>
                    <input type="hidden" name="runId" value={run.id} />
                    <Button type="submit" variant="ghost" size="xs">
                      Cancel
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
