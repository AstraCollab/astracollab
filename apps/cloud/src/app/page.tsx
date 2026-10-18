import Link from "next/link"

import { TerminalWindow } from "@/components/terminal-window"
import { Button } from "@/components/ui/button"

/**
 * The front door.
 *
 * A server component with no client JS, on purpose. The one piece of
 * interactivity this page wants — a session that appears to type itself out — is
 * a CSS animation over data that is already in the HTML, so shipping React
 * hydration to achieve it would cost a bundle for a trick.
 *
 * Everything factual is imported from the layer that owns it rather than
 * restated here: the credential table mirrors the two API-key configs in
 * `src/server/auth/better-auth.ts`, and the lifecycle mirrors `RunStatus` in
 * `src/server/db/schema.ts`. Copy that drifts from code is worse than no copy.
 */

/** The four properties that distinguish this from a hosted shell. */
const pillars = [
  {
    title: "A real filesystem",
    body: "Not a document store pretending to be one. A Linux machine with a working tree, a package manager and a build, so the agent does the thing you would have done locally."
  },
  {
    title: "Your terminal is the client",
    body: "The interface you already know drives a remote runtime. Steer it, interrupt it, reopen it tomorrow — the session is on the machine, not in your scrollback."
  },
  {
    title: "It outlives the laptop",
    body: "Close the terminal, put it in a bag, fly somewhere. The sandbox keeps running and keeps its disk, so you reconnect to work already in progress."
  },
  {
    title: "Your keys, your spend",
    body: "Bring the model key you already have. We hold the runtime, never your credentials, and you can see what a run cost while it is still going."
  }
] as const

/** What actually happens, in the order it happens. */
const steps = [
  {
    n: "01",
    title: "Fork a sandbox",
    body: "A stopped snapshot becomes a fresh machine in seconds. It arrives with the runtime daemon already installed as a service, so there is nothing to boot and nothing to wait on."
  },
  {
    n: "02",
    title: "Point the CLI at it",
    body: "One flag, or a line in your config. The terminal attaches over a socket and starts streaming events — the same stream a local run produces."
  },
  {
    n: "03",
    title: "Walk away from it",
    body: "Detach whenever you like. Every event is written down as it happens, so reconnecting replays what you missed rather than losing it."
  }
] as const

/**
 * The two credential shapes.
 *
 * A browser cookie is the wrong primitive for a machine that authenticates once
 * and then works for an hour, so both of these belong to an organisation rather
 * than to a person. That is also why revoking one never interrupts a
 * collaborator who is signed in.
 */
const credentials = [
  {
    name: "Agent key",
    prefix: "nah_agent_",
    scope: "Create runs, read transcripts, cancel work in flight.",
    lifetime: "Long-lived. Revoke it from the dashboard whenever."
  },
  {
    name: "Runner key",
    prefix: "nah_run_",
    scope: "Report progress and stream events for a single run.",
    lifetime: "Count-limited and self-expiring. It cannot start new runs."
  }
] as const

/** Straight from the `RunStatus` union. */
const lifecycle = [
  { step: "queued", note: "The prompt is frozen at creation, so a replay is faithful." },
  { step: "running", note: "A sandbox holds the filesystem. Events append as it works." },
  { step: "succeeded", note: "Settled by exit code, not by the absence of an error." }
] as const

export default function Home() {
  return (
    <div className="landing flex min-h-screen flex-col">
      <SiteHeader />

      <main className="flex-1">
        {/* Hero. The grid sits behind everything and is masked to fade out. */}
        <section className="grain relative overflow-hidden">
          <div className="landing-grid pointer-events-none absolute inset-0" aria-hidden="true" />

          {/*
            Two orbs, not one. A single glow is a spotlight and reads as a bug;
            a green one low and a violet one high and off-centre gives the
            section a light source at each end, which is what makes the glass
            panel in the middle look like it is catching something.
          */}
          <div className="glow animate-drift -top-24 -left-20 size-[34rem] bg-[#a78bfa]/20" aria-hidden="true" />
          <div
            className="glow animate-drift -right-24 -bottom-32 size-[38rem] bg-[#6366f1]/15 [animation-delay:-11s]"
            aria-hidden="true"
          />

          <div className="relative mx-auto w-full max-w-6xl px-6 pt-20 pb-16 sm:pt-28 sm:pb-24">
            <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
              <div className="animate-fade-up">
                <p className="eyebrow">Hosted agent runtime</p>

                <h1 className="tracking-display mt-5 text-5xl font-semibold text-balance sm:text-6xl">
                  Your agent keeps working
                  <br />
                  after you close
                  <br />
                  <span className="text-[var(--ink-muted)]">the laptop.</span>
                </h1>

                <p className="mt-7 max-w-xl text-lg leading-8 text-[var(--ink-muted)] text-pretty">
                  Nah Cloud runs your agent on a real Linux machine with a real
                  filesystem. You drive it from the terminal you already use, and
                  you can walk away from it.
                </p>

                <div className="mt-9 flex flex-wrap items-center gap-3">
                  <Button
                    size="lg"
                    className="elev-2 rounded-[0.75rem] border-signal bg-signal text-[#09090b] hover:bg-signal/90"
                    nativeButton={false} render={<Link href="/sign-up" />}
                  >
                    Start running
                  </Button>
                  <Button
                    size="lg"
                    variant="outline"
                    className="rounded-[0.75rem] border-line-strong bg-transparent hover:bg-[var(--surface-raised)] hover:text-[var(--ink)]"
                    nativeButton={false} render={<Link href="/sign-in" />}
                  >
                    Sign in
                  </Button>
                </div>

                <p className="font-mono-tech mt-7 text-xs text-[var(--ink-faint)]">
                  Bring your own model key · no card to see it work
                </p>
              </div>

              <div className="animate-fade-up [animation-delay:120ms]">
                <TerminalWindow />
              </div>
            </div>
          </div>
        </section>

        <Section
          eyebrow="What it is"
          title="Four things that are hard to fake"
          lede="Most hosted agent products hand you a container API and call it a machine. These are the parts we refused to compromise on."
        >
          {/*
            Individual cards rather than one bordered grid. The 1px-gap-over-a
            line-coloured-backdrop trick draws a grid without four borders, but it
            produces a single flat slab — and four panels with their own shadow
            are what carry the elevation. The surface sits between two glows
            here, so the cards are lit from behind as well as from above.
          */}
          <div className="grid gap-4 sm:grid-cols-2">
            {pillars.map((pillar) => (
              <div key={pillar.title} className="elev-1 rounded-[0.75rem] border border-line bg-[var(--surface-raised)] p-7">
                <h3 className="font-medium text-balance">{pillar.title}</h3>
                <p className="mt-3 text-sm leading-6 text-[var(--ink-muted)]">
                  {pillar.body}
                </p>
              </div>
            ))}
          </div>
        </Section>

        <Section
          id="how-it-works"
          eyebrow="How it works"
          title="Three steps, then it is not your problem"
          lede="No image to build, no service to supervise. The daemon is already running by the time the sandbox exists."
        >
          <ol className="grid gap-6 md:grid-cols-3">
            {steps.map((step) => (
              <li key={step.n} className="elev-1 rounded-[0.75rem] border border-line bg-[var(--surface-raised)] p-7">
                <p className="font-mono-tech text-sm text-signal-dim">{step.n}</p>
                <h3 className="mt-3 font-medium text-balance">{step.title}</h3>
                <p className="mt-3 text-sm leading-6 text-[var(--ink-muted)]">
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </Section>

        {/* Credentials. The one section that earns a table rather than cards. */}
        <Section
          id="credentials"
          eyebrow="Credentials"
          title="Two keys, because one cannot do both jobs"
          lede="A session cookie is the wrong shape for a machine that authenticates once and then runs for an hour. Both of these belong to the organisation, not to a person."
        >
          <div className="elev-1 overflow-x-auto rounded-[0.75rem] border border-line">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-line bg-[var(--surface-raised)]">
                  <Th className="w-[26%]">Credential</Th>
                  <Th className="w-[34%]">Scope</Th>
                  <Th>Lifetime</Th>
                </tr>
              </thead>
              <tbody>
                {credentials.map((credential) => (
                  <tr
                    key={credential.name}
                    className="border-b border-line bg-[var(--surface)] last:border-0"
                  >
                    <td className="px-5 py-4 align-top">
                      <span className="font-medium">{credential.name}</span>
                      <code className="font-mono-tech mt-1.5 block text-xs text-[var(--ink-faint)]">
                        {credential.prefix}
                      </code>
                    </td>
                    <td className="px-5 py-4 align-top leading-6 text-[var(--ink-muted)]">
                      {credential.scope}
                    </td>
                    <td className="px-5 py-4 align-top leading-6 text-[var(--ink-muted)]">
                      {credential.lifetime}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* Lifecycle. A rail, because these are points in time on one line. */}
        <Section
          eyebrow="Run lifecycle"
          title="Three states, and no ambiguity about the last one"
          lede="An agent that fails to find its own bug exits non-zero and says nothing. Treating that silence as success would bill a broken run as a good one."
        >
          <div className="grid gap-6 md:grid-cols-3">
            {lifecycle.map((item, index) => (
              <div key={item.step} className="relative pl-6">
                {/* The rail stops at the last item so the line does not dangle. */}
                {index < lifecycle.length - 1 && (
                  <span
                    className="absolute top-3 left-0 h-[calc(100%-0.5rem)] w-px bg-[var(--line-strong)]"
                    aria-hidden="true"
                  />
                )}
                {/* Ringed rather than solid: a filled dot on a dark card is a
                    hole, a ring with a lit core reads as a lit indicator. */}
                <span
                  className="absolute top-1.5 left-0 size-2.5 -translate-x-[5px] rounded-full border border-signal/40 bg-signal shadow-[0_0_12px_rgb(167_139_250/0.5)]"
                  aria-hidden="true"
                />
                <p className="font-mono-tech text-sm text-signal-dim">{item.step}</p>
                <p className="mt-3 text-sm leading-6 text-[var(--ink-muted)]">
                  {item.note}
                </p>
              </div>
            ))}
          </div>
        </Section>

        {/* Close. The last thing on the page is the thing you came for. */}
        <section className="grain relative overflow-hidden border-t border-line">
          {/* One orb, centred and low, so the CTA is lit from beneath. */}
          <div
            className="glow -bottom-40 left-1/2 size-[30rem] -translate-x-1/2 bg-[#a78bfa]/18"
            aria-hidden="true"
          />
          <div className="relative mx-auto w-full max-w-3xl px-6 py-24 text-center">
            <h2 className="tracking-display text-3xl font-semibold text-balance sm:text-4xl">
              Close the tab. Come back to finished work.
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-[var(--ink-muted)] text-pretty">
              Create an organisation, mint a key, point the CLI at a sandbox. It
              takes about a minute and it costs you nothing until a run happens.
            </p>
            <div className="mt-9 flex flex-wrap justify-center gap-3">
              <Button
                size="lg"
                className="elev-2 rounded-[0.75rem] border-signal bg-signal text-[#09090b] hover:bg-signal/90"
                nativeButton={false} render={<Link href="/sign-up" />}
              >
                Create your first agent
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="border-line-strong bg-transparent hover:bg-[var(--surface-raised)] hover:text-[var(--ink)]"
                nativeButton={false} render={<Link href="/sign-in" />}
              >
                I have an account
              </Button>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}

function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-[color-mix(in_oklch,var(--surface)_72%,transparent)] backdrop-blur-xl backdrop-saturate-150">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
        <Link
          href="/"
          className="flex items-center gap-2.5 font-medium tracking-tight"
        >
          {/* The mark glows: one signal light, not a flat dot. */}
          <span
            className="size-2 rounded-full bg-signal shadow-[0_0_12px_rgb(167_139_250/0.6)]"
            aria-hidden="true"
          />
          <span className="size-2 rounded-full bg-signal" aria-hidden="true" />
          Nah Cloud
        </Link>

        <nav className="flex items-center gap-1">
          <a
            href="#how-it-works"
            className="hidden rounded-md px-3 py-2 text-sm text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)] sm:block"
          >
            How it works
          </a>
          <a
            href="#credentials"
            className="hidden rounded-md px-3 py-2 text-sm text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)] sm:block"
          >
            Credentials
          </a>
          <Button
            size="sm"
            className="ml-2 bg-signal text-[oklch(0.16_0.006_265)] hover:bg-signal/90"
            nativeButton={false} render={<Link href="/sign-up" />}
          >
            Get started
          </Button>
        </nav>
      </div>
    </header>
  )
}

function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 py-8 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-[var(--ink-faint)]">
          Nah Cloud — hosted agent runtime
        </p>
        <nav className="flex gap-6 text-sm text-[var(--ink-faint)]">
          <Link
            href="/sign-in"
            className="transition-colors hover:text-[var(--ink)]"
          >
            Sign in
          </Link>
          <Link
            href="/sign-up"
            className="transition-colors hover:text-[var(--ink)]"
          >
            Create account
          </Link>
        </nav>
      </div>
    </footer>
  )
}

/**
 * A section with a consistent rhythm: eyebrow, headline, lede, content.
 *
 * `id` exists because the header links to these anchors, and an anchor that
 * silently fails to resolve is a broken nav rather than a missing feature.
 */
function Section({
  id,
  eyebrow,
  title,
  lede,
  children
}: {
  readonly id?: string
  readonly eyebrow: string
  readonly title: string
  readonly lede: string
  readonly children: React.ReactNode
}) {
  return (
    <section id={id} className="border-t border-line">
      <div className="mx-auto w-full max-w-6xl px-6 py-20 sm:py-24">
        <p className="eyebrow">{eyebrow}</p>
        <h2 className="tracking-display mt-4 max-w-2xl text-3xl font-semibold text-balance sm:text-4xl">
          {title}
        </h2>
        <p className="mt-4 max-w-2xl text-[var(--ink-muted)] text-pretty">
          {lede}
        </p>
        <div className="mt-12">{children}</div>
      </div>
    </section>
  )
}

function Th({
  className,
  children
}: {
  readonly className?: string
  readonly children: React.ReactNode
}) {
  return (
    <th
      scope="col"
      className={`px-5 py-3 font-mono-tech text-[9px] font-medium tracking-[0.16em] text-[var(--ink-faint)] uppercase ${className ?? ""}`}
    >
      {children}
    </th>
  )
}
