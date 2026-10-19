import net from "node:net"

/**
 * The public origin of a deployment, checked over real HTTP.
 *
 * The unit test covers how the origin is resolved from headers. This covers the
 * part a unit test cannot: what Next.js actually hands the app. It fills
 * `x-forwarded-proto` in with the scheme of the internal hop when no proxy sent
 * one, so a request that arrived over http reaches the app claiming to be http
 * — and the app has to work out its public origin without being told.
 *
 * The requests go over a socket rather than through `fetch`, because `fetch`
 * refuses to set `Host`: a request addressed to a name is the case here, and a
 * header the client cannot set is a header that cannot be tested.
 *
 * Start the app first, the way it is started in production:
 *
 *   NODE_ENV=production BETTER_AUTH_SECRET=… pnpm --filter cognitive-memory start
 *   npx tsx scripts/verify-origin.ts
 */

const BASE = new URL(process.env.COGNITIVE_MEMORY_VERIFY_BASE_URL ?? "http://127.0.0.1:3999")
const HOST = process.env.COGNITIVE_MEMORY_VERIFY_HOST ?? "cogmem.astracollab.app"

let passed = 0
let failed = 0

const check = (label: string, condition: boolean, detail?: unknown): void => {
  if (condition) {
    passed += 1
    process.stdout.write(`  ok   ${label}\n`)
  } else {
    failed += 1
    process.stdout.write(
      `  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}\n`
    )
  }
}

interface Reply {
  status: number
  headers: Record<string, string>
  body: string
}

/** One HTTP request, sent by hand. */
const request = async (
  path: string,
  headers: Record<string, string>,
  body?: string
): Promise<Reply> => {
  const lines = [
    `POST ${path} HTTP/1.1`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    ...(body === undefined ? [] : [`content-length: ${Buffer.byteLength(body)}`]),
    "connection: close",
    "",
    body ?? ""
  ]

  return new Promise<Reply>((resolve, reject) => {
    const socket = net.connect(Number(BASE.port || 80), BASE.hostname, () => {
      socket.write(lines.join("\r\n"))
    })

    let received = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      received += chunk
    })
    socket.on("error", reject)
    socket.on("close", () => {
      const [head = "", ...rest] = received.split("\r\n\r\n")
      const [statusLine = "", ...headerLines] = head.split("\r\n")
      const status = Number(statusLine.split(" ")[1] ?? 0)
      const replyHeaders: Record<string, string> = {}
      for (const line of headerLines) {
        const at = line.indexOf(":")
        if (at > 0) replyHeaders[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
      }
      resolve({ status, headers: replyHeaders, body: rest.join("\r\n\r\n") })
    })
  })
}

/** A sign-up, as a browser on the deployment would send it. */
const signUp = async (
  headers: Record<string, string>,
  label: string
): Promise<Reply> => {
  const body = JSON.stringify({
    name: "Verifier",
    // One account per run, because the store keeps the accounts it is given.
    email: `verify-${label}-${Date.now()}@example.com`,
    password: "a-long-enough-password"
  })

  return request("/api/auth/sign-up/email", {
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    ...headers
  }, body)
}

const run = async (): Promise<void> => {
  process.stdout.write(`verifying the public origin against ${BASE.origin}\n`)

  const throughProxy = await signUp(
    {
      host: HOST,
      "x-forwarded-host": HOST,
      "x-forwarded-proto": "https",
      origin: `https://${HOST}`
    },
    "proxy"
  )

  check("a request through a proxy signs up", throughProxy.status === 200, throughProxy.body)
  check(
    "the session cookie is secure",
    (throughProxy.headers["set-cookie"] ?? "").includes("__Secure-"),
    throughProxy.headers["set-cookie"]
  )

  // Addressed by its public name, with no proxy in front: Next.js fills the
  // forwarded host in from `Host` and the forwarded scheme in with the scheme
  // of the internal hop, and the app still has to name the public origin.
  const addressed = await signUp({ host: HOST, origin: `https://${HOST}` }, "addressed")

  check(
    "a request addressed to the deployment signs up",
    addressed.status === 200,
    addressed.body
  )

  const foreign = await signUp(
    {
      host: HOST,
      "x-forwarded-host": HOST,
      "x-forwarded-proto": "https",
      origin: "https://elsewhere.example"
    },
    "foreign"
  )

  check(
    "an origin that is not this deployment is refused",
    foreign.status === 403 && foreign.body.includes("INVALID_ORIGIN"),
    foreign.body
  )
}

void run().then(() => {
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed === 0 ? 0 : 1)
})
