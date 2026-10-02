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
  title: "Credentials",
  description:
    "Sessions and API keys, why the separation is the security model, and why the key hash is sha256 rather than a slow derivation."
}

/**
 * Credentials.
 *
 * Two kinds of credential, deliberately separated. The separation is the security
 * model, so this page is mostly about what each one cannot do.
 */

const SECTIONS: readonly DocSectionSpec[] = [
  {
    id: "two",
    title: "Two kinds",
    body: (
      <>
        <DocTable
          columns={[
            { label: "", width: "9rem" },
            { label: "Identifies", width: "10rem" },
            { label: "Authority" }
          ]}
          rows={[
            [
              <b key="s">Session</b>,
              "A person",
              "Better Auth owns users, sessions and organisations. The dashboard uses these, and it is the only thing that can create an organisation or mint a key."
            ],
            [
              <b key="k">API key</b>,
              "An agent",
              "Opaque, scoped, individually revocable, stored as a sha256 hash. Resolves to one organisation and a set of scopes, and can only read and write that organisation’s memory."
            ]
          ]}
        />
        <p>
          A key looks like{" "}
          <code>cmi_&lt;env&gt;_&lt;id&gt;_&lt;secret&gt;</code>, where the
          environment half is <code>dev</code> or <code>prod</code> from{" "}
          <code>COGNITIVE_MEMORY_ENV</code>. The secret is shown exactly once,
          because only its hash is stored.
        </p>
        <Callout>
          The dashboard is authenticated by session and{" "}
          <code>/api/dashboard/*</code> never accepts an API key. Reaching for a
          key to look at your own memory would train exactly the habit this service
          is trying to discourage.
        </Callout>
      </>
    )
  },
  {
    id: "model",
    title: "The separation is the model",
    body: (
      <>
        <p>
          A leaked agent key cannot mint a new key, cannot change its own scopes,
          and cannot create an organisation. Rotation happens from a signed-in
          session.
        </p>
        <p>
          That is not a limitation of the current implementation, it is the reason
          the two authenticators exist. Keys are how a caller escalates, so minting
          one must require the human.
        </p>
        <p>
          There is one exception, and it is deliberate: a{" "}
          <Link href="/docs/api#scopes"><code>keys:manage</code></Link> scope lets a
          key rotate its siblings for the same organisation, which is the CI case.
          It still cannot create an organisation and it still cannot widen its own
          scopes.
        </p>
        <p>
          Every read is filtered by organisation id in one auditable layer, so
          cross-tenant access is a single check rather than a property every query
          has to remember.
        </p>
      </>
    )
  },
  {
    id: "hashing",
    title: "Why sha256",
    body: (
      <>
        <p>
          Keys are stored as a sha256 hash, not a slow key derivation like
          bcrypt or argon2. That looks like a mistake and is not.
        </p>
        <p>
          Password hashing exists to make guessing a human password expensive.
          These secrets carry 256 bits of entropy, so there is no search to slow
          down, and a deliberately slow hash would add latency to every request to
          protect against an attack that cannot happen.
        </p>
        <p>
          The public prefix means a presented key is one indexed lookup and one
          constant-time comparison — the prefix narrows the candidate row before the
          hash is computed at all.
        </p>
        <Warning title="Losing a key is not recoverable">
          Because only the hash is stored, a lost secret cannot be shown again.{" "}
          <Link href="/dashboard/keys">Revoke it and issue another</Link> — the
          alternative, a reset that reveals the old value, would mean storing
          something reversible.
        </Warning>
      </>
    )
  },
  {
    id: "lifecycle",
    title: "Issuing, scoping, revoking",
    body: (
      <>
        <p>
          From <Link href="/dashboard/keys">the dashboard</Link>, or over HTTP from
          a signed-in session. A new key gets{" "}
          <code>memories:read</code>, <code>memories:write</code> and{" "}
          <code>stats:read</code>; narrow it to what the agent actually does.
        </p>
        <CodeBlock language="sh">{`# Session-authenticated: a cookie, not a key.
curl -X POST localhost:3000/api/v1/keys \\
  -H "content-type: application/json" \\
  -b "$SESSION_COOKIE" \\
  -d '{"name":"ci","scopes":["memories:read","memories:write"],"expiresInDays":30}'`}</CodeBlock>
        <p>
          Keys carry an optional expiry and report a{" "}
          <code>status</code> of <code>active</code>, <code>expired</code> or{" "}
          <code>revoked</code>, alongside <code>lastUsedAt</code> — so an unused key
          is visible as unused rather than merely never mentioned.
        </p>
        <p>
          Every key is individually revocable, and revocation is immediate. A
          present key that is revoked, expired or unknown answers{" "}
          <code>401 Unauthorized</code> rather than{" "}
          <code>403</code> — the key is not wrong, it no longer exists. A valid key
          missing a scope gets <code>403</code> with{" "}
          <code>requiredScope</code> naming it.{" "}
          <Link href="/docs/api#errors">The error table</Link> has the rest.
        </p>
      </>
    )
  },
  {
    id: "production",
    title: "Before production",
    body: (
      <>
        <p>
          <code>BETTER_AUTH_SECRET</code> is required in production, and{" "}
          <code>GET /api/v1/health</code> reports its absence in{" "}
          <code>problems</code> rather than failing a sign-in at runtime.
        </p>
        <p>
          Every read is filtered by organisation, so the thing to get right before
          real data is the organisation boundary rather than the key format. The
          <Link href="/docs/self-hosting">configuration reference</Link> lists the
          two auth values and everything else.
        </p>
      </>
    )
  }
]

export default function AuthPage() {
  return (
    <DocPage
      href="/docs/auth"
      title="Credentials"
      description="A session identifies a person, an API key identifies an agent, and neither can do the other’s job. That separation is the security model."
      sections={SECTIONS}
    />
  )
}
