import Link from "next/link"

import { Button } from "@/components/ui/button"

/**
 * The control plane's front door.
 *
 * Deliberately a server component. The obvious temptation here is to show live
 * counts — agents, runs, tokens — pulled from Postgres, which would make this
 * dynamic and force a database connection on every request to the root. Nothing
 * on this page needs to be live, and a marketing page that costs a query to say
 * nothing is a page that will eventually time out.
 *
 * Everything factual comes from the auth and schema layer beside it rather than
 * being restated here, so the two cannot drift: the plans below describe the two
 * API-key configs in `src/server/auth/better-auth.ts`, and the lifecycle in
 * `src/server/db/schema.ts`.
 */

const plans = [
  {
    name: "Agent key",
    prefix: "nah_agent_",
    scope: "Create runs, read transcripts, cancel in-flight work.",
    lifetime: "Long-lived, revocable from the dashboard.",
    emphasis: true
  },
  {
    name: "Runner key",
    prefix: "nah_run_",
    scope: "Report progress and stream events for a single run.",
    lifetime: "Count-limited, self-expiring. Cannot create runs.",
    emphasis: false
  }
] as const

const lifecycle = [
  { step: "queued", note: "The prompt is frozen at creation so a replay is faithful." },
  { step: "running", note: "A sandbox holds the filesystem; events append as it works." },
  { step: "succeeded", note: "Settled by exit code, not by the absence of an error message." }
] as const

export default function Home() {
  return (
    <div className="flex min-h-full flex-col bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-6">
          <span className="font-medium tracking-tight">Nah Cloud</span>
          <nav className="flex items-center gap-1">
            <Button variant="ghost" size="sm" render={<Link href="/sign-in" />}>
              Sign in
            </Button>
            <Button size="sm" render={<Link href="/sign-up" />}>
              Get started
            </Button>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-20">
        <section className="max-w-2xl">
          <h1 className="text-4xl font-semibold tracking-tight text-balance">
            Your agents, hosted.
          </h1>
          <p className="mt-4 text-lg leading-8 text-muted-foreground text-pretty">
            Run the terminal UI against a remote runtime with a real filesystem.
            Point <code className="font-mono text-[0.9em]">nah</code> at a backend and
            the same interface drives an agent that outlives your laptop.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button size="lg" render={<Link href="/sign-up" />}>
              Create an agent
            </Button>
            <Button size="lg" variant="outline" render={<Link href="/sign-in" />}>
              I already have an account
            </Button>
          </div>
        </section>

        <section className="mt-20">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Two kinds of credential
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            A browser session is the wrong shape for a machine that authenticates
            once and then runs for an hour. Both keys below belong to an
            organisation rather than a person, so revoking one never interrupts a
            signed-in collaborator.
          </p>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {plans.map((plan) => (
              <div
                key={plan.name}
                className="rounded-lg border bg-card p-5 text-card-foreground"
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-medium">{plan.name}</h3>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                    {plan.prefix}
                  </code>
                </div>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{plan.scope}</p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {plan.lifetime}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-20">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Run lifecycle
          </h2>
          <ol className="mt-6 space-y-4">
            {lifecycle.map((item, index) => (
              <li key={item.step} className="flex gap-4">
                <span className="mt-0.5 font-mono text-xs text-muted-foreground">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <h3 className="font-mono text-sm">{item.step}</h3>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {item.note}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto w-full max-w-5xl px-6 py-6 text-sm text-muted-foreground">
          Nah Cloud — hosted agent runtime
        </div>
      </footer>
    </div>
  )
}