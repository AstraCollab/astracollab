import type { Metadata } from "next"
import Link from "next/link"

import { CodeBlock } from "@/components/docs/code-block"
import { DocPage } from "@/components/docs/page"
import {
  Callout,
  DocTable,
  Warning,
  type DocSectionSpec
} from "@/components/docs/primitives"

export const metadata: Metadata = {
  title: "Self-hosting",
  description:
    "Run the service yourself: installation, every environment variable, per-organisation budget overrides, migrations, and the operations scripts."
}

/**
 * Self-hosting.
 *
 * The service is a Next.js app over SQLite, so there is nothing to orchestrate —
 * which is also why the configuration surface is small enough to print in full.
 * Every variable is listed, with its default, because a budget you cannot see is
 * a budget you cannot reason about, and the defaults here are the numbers the
 * design arguments are made against.
 */

/**
 * Variable, default, and what it is for.
 *
 * Two columns rather than three, with the note under the name. Three columns
 * meant the note — the only prose in the table — got what was left over after two
 * long monospace fields, which is roughly five words wide, and every row became
 * eight lines tall.
 */
const CONFIG: ReadonlyArray<readonly [string, string, string]> = [
  [
    "COGNITIVE_MEMORY_DATABASE_PATH",
    ".cognitive-memory/cognitive-memory.sqlite",
    "SQLite file. The directory is created on first connection."
  ],
  [
    "COGNITIVE_MEMORY_MAX_TOTAL_TOKENS",
    "2000",
    "Ceiling on everything injected into one prompt, index and bodies together. When the cap bites the response reports truncated: true."
  ],
  [
    "COGNITIVE_MEMORY_MAX_INDEX_ITEMS",
    "60",
    "Index lines per prompt, so a large store cannot fill the window."
  ],
  [
    "COGNITIVE_MEMORY_DEFAULT_RECALL_LIMIT",
    "8",
    "Default result count for POST /v1/recall."
  ],
  [
    "COGNITIVE_MEMORY_MODEL_API_KEY",
    "—",
    "Enables model-backed extraction. With no key the service still learns from deterministic patterns."
  ],
  [
    "COGNITIVE_MEMORY_MODEL_BASE_URL",
    "OpenAI",
    "Any OpenAI-compatible gateway, including a local one."
  ],
  ["COGNITIVE_MEMORY_MODEL_NAME", "gpt-4o-mini", ""],
  [
    "COGNITIVE_MEMORY_ENV",
    "dev / prod",
    "The environment half of a minted key: cmi_dev_… or cmi_prod_…."
  ],
  [
    "BETTER_AUTH_SECRET",
    "—",
    "Required in production. Generate with openssl rand -base64 32."
  ],
  ["BETTER_AUTH_URL", "http://localhost:3000", ""]
]

const SECTIONS: readonly DocSectionSpec[] = [
  {
    id: "run",
    title: "Run it",
    body: (
      <>
        <p>
          Node.js 22.19 or newer. The SDK is a workspace dependency, so build it
          before the app on a fresh checkout.
        </p>
        <CodeBlock language="sh">{`pnpm install
pnpm --filter @astracollab/cogmem build
pnpm --filter cognitive-memory dev`}</CodeBlock>
        <p>
          Open <code>http://localhost:3000</code>, sign up, and mint a key. Every
          environment value is optional in development — the service creates its
          SQLite file and its schema on first connection, and a key is still
          required in production.
        </p>
        <CodeBlock language="sh">{"cp .env.example .env.local"}</CodeBlock>
      </>
    )
  },
  {
    id: "config",
    title: "Configuration",
    body: (
      <>
        <p>
          These set the <b>deployment defaults</b>. Each organisation can override
          the three budgets from the dashboard, and{" "}
          <code>null</code> means it follows the deployment again — see{" "}
          <Link href="/docs/dashboard">the dashboard</Link>.
        </p>
        <DocTable
          columns={[
            { label: "Variable", width: "18rem" },
            { label: "Default", width: "10rem", mono: true }
          ]}
          rows={CONFIG.map(([name, value, note]) => [
            <span key={name}>
              <span className="block font-mono text-[11px] text-violet-200">{name}</span>
              {note ? (
                <span className="mt-1 block text-xs leading-5 text-zinc-500">{note}</span>
              ) : null}
            </span>,
            value
          ])}
        />
        <Callout>
          With no model key the service is not degraded, it is rules-only:
          deterministic patterns still learn URLs, assignments and stated
          requirements, and <code>GET /api/v1/health</code> reports{" "}
          <code>extractor: &quot;rules-only&quot;</code>. Check that field before
          concluding that extraction is broken.
        </Callout>
      </>
    )
  },
  {
    id: "budgets",
    title: "Budgets",
    body: (
      <>
        <p>
          The per-prompt ceiling is the single most consequential number in the
          deployment, and it is the one most likely to be set by copying the
          default. The useful question is not &ldquo;how big can this be&rdquo; but{" "}
          &ldquo;how much of this store is worth a full body&rdquo; — because index
          lines and bodies have very different prices and very different values.
        </p>
        <p>
          A build that spends its whole budget on index lines and no bodies is not
          a memory that needs a bigger budget. It is a store with nothing worth
          promoting, and the two problems have opposite fixes.{" "}
          <Link href="/dashboard/analytics">Analytics</Link> splits the spend by
          reason precisely so this is visible rather than guessed at.
        </p>
        <Warning title="Truncation is reported, never silent">
          When the cap bites, the response carries <code>truncated: true</code>{" "}
          rather than quietly dropping the tail. The least recently accessed
          entries are the ones that lose their place, so a store that is
          constantly over budget converges on a small hot set — which is a
          legitimate outcome, but only if you meant it.
        </Warning>
      </>
    )
  },
  {
    id: "operations",
    title: "Migrations and operations",
    body: (
      <>
        <DocTable
          columns={[
            { label: "Command", width: "18rem", mono: true },
            { label: "What it does" }
          ]}
          rows={[
            ["pnpm --filter cognitive-memory db:generate", "drizzle-kit generate"],
            ["pnpm --filter cognitive-memory db:migrate", "Apply migrations."],
            ["pnpm --filter cognitive-memory db:studio", "Browse the database."],
            [
              "pnpm --filter cognitive-memory auth:generate",
              "Regenerate the Better Auth schema."
            ],
            ["pnpm --filter cognitive-memory test", "Engine, dashboard, rules (56 tests)."],
            ["pnpm --filter cognitive-memory typecheck", ""],
            [
              "pnpm --filter cognitive-memory measure",
              "Regenerate the recall and token figures."
            ],
            ["pnpm --filter cognitive-memory smoke", "In-process smoke run."],
            ["pnpm --filter cognitive-memory smoke:http", "63 checks over real HTTP."]
          ]}
        />
        <p>
          <code>measure</code> is worth running against your own store rather than
          trusting the published numbers, because the ratio between index lines and
          full bodies depends entirely on what your agents have been told.
        </p>
        <CodeBlock language="ts">{`GET /api/v1/health   // liveness, limits, extractor mode. No key spent.`}</CodeBlock>
      </>
    )
  },
  {
    id: "stack",
    title: "What it is built on",
    body: (
      <>
        <DocTable
          columns={[
            { label: "Piece", width: "12rem" },
            { label: "Used for" }
          ]}
          rows={[
            [<b key="a">Next.js 16</b>, "App Router, route handlers, Turbopack"],
            [
              <b key="b">Effect 4</b>,
              "Services, layers, typed error channel, ManagedRuntime at the HTTP boundary"
            ],
            [<b key="c">Drizzle</b>, "Schema, migrations, synchronous queries over better-sqlite3"],
            [<b key="d">Better Auth</b>, "Users, sessions, organisations"],
            [<b key="e">effect/ai</b>, "Optional model-backed extraction and reconciliation"]
          ]}
        />
        <p>
          The server has no <code>await</code> in its domain logic: every service
          returns an <code>Effect</code>, one <code>respond</code> helper maps a
          tagged error to a status, and route handlers are ordinary{" "}
          <code>async</code> functions that await a <code>Response</code>. The
          consequence for you is that an error is a value you can match on — which
          is what makes <Link href="/docs/api">the error shape</Link> uniform
          enough to branch on.
        </p>
      </>
    )
  }
]

export default function SelfHostingPage() {
  return (
    <DocPage
      href="/docs/self-hosting"
      title="Self-hosting"
      description="A Next.js app over SQLite, so there is nothing to orchestrate. What there is, is a configuration surface worth reading in full — the defaults below are the numbers the design arguments are made against."
      sections={SECTIONS}
    />
  )
}
