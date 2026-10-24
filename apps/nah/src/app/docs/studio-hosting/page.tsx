import Link from "next/link";
import { Code, DocHeader, DocSection, DocsShell, Note } from "@/components/docs/DocsShell";

export default function StudioHostingPage() {
  return <DocsShell current="/docs/studio-hosting">
    <DocHeader eyebrow="OPERATE / NAH STUDIO" title="Host Studio where your agents can reach it." description="Run the NAH Studio server as a long-lived Node process, keep its SQLite database on persistent storage, and send agent traces to its HTTP API. This guide covers local development and a single-host deployment." />

    <DocSection id="what-is-studio" title="What Studio does">
      <p>NAH Studio is the dashboard and API for agent visibility: it stores agent registrations and run traces, serves the browser UI, and exposes live updates over server-sent events. The executable is <code>nah-studio</code>; <code>nah serve</code> is a convenience command from the NAH CLI that starts Studio locally.</p>
      <p>Studio is separate from <Link href="/docs/web" className="text-violet-200 hover:text-white">nah-js</Link>. Use nah-js to serve your own agent through a web application API. Use Studio to inspect agents and traces. An application can use both: serve user requests with nah-js and report those runs to Studio.</p>
      <Note title="Deployment shape">Studio is a stateful Node server backed by a local SQLite file. Run it as a long-lived process on a host with persistent disk. A serverless function or an ephemeral container filesystem is not a suitable place for the database.</Note>
    </DocSection>

    <DocSection id="local" title="Start locally">
      <p>On your development machine, start the dashboard from a shell or from an active <code>nah</code> session:</p>
      <Code>{"nah serve\n# or choose a port\nnah serve --port 5000\n\n# check, print the URL, or stop it\nnah serve status\nnah serve url\nnah serve stop"}</Code>
      <p>For a direct package invocation, <code>nah-studio</code> listens on <code>127.0.0.1:4111</code> by default. Open the printed URL in a browser. The loopback default needs no token.</p>
    </DocSection>

    <DocSection id="deploy" title="Deploy a persistent Studio server">
      <p>Install <code>nah-studio</code> on a supported Node host, provision a writable persistent directory for SQLite, and keep the process running under your process manager. For example:</p>
      <Code language="sh">{"export NAH_STUDIO_TOKEN='replace-with-a-long-random-secret'\nnpx --yes nah-studio \\\n+  --host 0.0.0.0 \\\n+  --port 4111 \\\n+  --db /var/lib/nah-studio/studio.sqlite \\\n+  --no-publish"}</Code>
      <p>Use a process manager such as systemd, Docker with a mounted volume, or your platform&apos;s long-running service. Keep the database path on that persistent volume, restart the process after a crash, and route HTTPS traffic through your reverse proxy or platform ingress. Restrict access to the Studio host and its API to the users and agents that should see traces.</p>
      <p>Set <code>NAH_STUDIO_TOKEN</code> in the service&apos;s secret environment. When Studio binds beyond loopback, it requires a bearer token on every request, including browser requests. Do not put the token in a URL or commit it to source control. <code>--no-publish</code> prevents this server from writing its endpoint to the service account&apos;s <code>~/.nah/studio.json</code>; use it for a standalone deployment that remote clients configure explicitly.</p>
      <Note title="The token protects the whole Studio API">Studio uses one shared bearer token rather than per-user accounts. Anyone who has it can access the dashboard and API. Keep it private and terminate TLS at a trusted ingress before sending traffic across a network.</Note>
    </DocSection>

    <DocSection id="connect-local" title="Connect agents on the same host">
      <p>When Studio starts without <code>--no-publish</code>, it writes its URL and token to <code>~/.nah/studio.json</code> with owner-only file permissions. NAH CLI sessions running as that same OS user discover the endpoint and report agent presence and traces automatically. The endpoint file is local discovery; a process on another host cannot read it.</p>
      <Code>{"# Start Studio on this machine\nnah serve\n\n# In another terminal, start an agent as the same user\nnah -p \"Summarize the changes in this repository\""}</Code>
      <p>Reporting is enabled when a live local Studio endpoint exists. Turn it off for a session with <code>NAH_TELEMETRY=off</code>, or use <code>/telemetry off</code> in the CLI to remember the preference.</p>
    </DocSection>

    <DocSection id="connect-remote" title="Connect agents on another host">
      <p>A remote NAH CLI does not currently have a supported setting to point its built-in telemetry discovery at a remote Studio URL: it reads the local endpoint file and checks that the recorded Studio process is alive on that machine. For agents you own, send trace data to Studio&apos;s HTTP API from your server-side agent runtime. The token belongs in server configuration, never in browser code.</p>
      <p>The trace ingest endpoint accepts an agent identity, a trace, and its spans. This example shows the wire format; map your runtime&apos;s trace and span objects to the Studio schema.</p>
      <Code language="ts">{"const response = await fetch(`${process.env.NAH_STUDIO_URL}/api/traces`, {\n  method: \"POST\",\n  headers: {\n    \"content-type\": \"application/json\",\n    authorization: `Bearer ${process.env.NAH_STUDIO_TOKEN}`,\n  },\n  body: JSON.stringify({\n    agent: {\n      id: \"support-prod-01\",\n      name: \"support-agent\",\n      cwd: \"/srv/support-agent\",\n      host: process.env.HOSTNAME ?? \"worker\",\n      pid: process.pid,\n      model: \"provider:model-id\",\n      version: \"1.0.0\",\n    },\n    trace,  // trace id, name, startTime, endTime, rootSpanId, status, tags, metadata\n    spans,  // the spans belonging to this trace\n    final: true,\n  }),\n});\n\nif (!response.ok) {\n  throw new Error(`Studio ingest failed: ${response.status}`);\n}"}</Code>
      <p>Use a stable agent ID so runs group under one agent. A trace can also be posted in partial batches with <code>final: false</code>; the finished post uses <code>final: true</code>. Ingest is idempotent by trace ID, and a trace post registers its agent if needed. The server checks the token on every request.</p>
      <Note title="Choose your telemetry boundary">Studio trace records can include prompts and tool inputs and outputs. Send only the fields your organization is allowed to retain, and redact sensitive values before ingestion.</Note>
    </DocSection>

    <DocSection id="health-api" title="Health checks and API">
      <p>Use the health endpoint for a process or load-balancer check. Add the bearer header when the server is token protected.</p>
      <Code>{"curl --fail \\\n+  -H \"Authorization: Bearer $NAH_STUDIO_TOKEN\" \\\n+  https://studio.example.com/api/health"}</Code>
      <p>The server also exposes <code>GET /api/agents</code>, <code>GET /api/traces</code>, <code>GET /api/overview</code>, and <code>GET /api/stream</code>. See the <code>nah-studio</code> API reference for the complete route list and query parameters.</p>
    </DocSection>

    <DocSection id="limits" title="Operational notes">
      <ul className="list-disc space-y-2 pl-5">
        <li>Back up the SQLite file while Studio is stopped or with a SQLite-aware backup process.</li>
        <li>Use one Studio process per database file; the documented deployment is a single long-lived instance with local SQLite storage.</li>
        <li>Studio can launch and stop agents only on the host where those processes run. A remote client reporting traces does not make its process controllable from Studio.</li>
        <li>Keep the server&apos;s working directory and <code>--nah-bin</code> configured appropriately if you use Studio features that launch agents or run workspace workflows.</li>
      </ul>
      <p>For building an HTTP agent endpoint instead of hosting the observability dashboard, see <Link href="/docs/web" className="text-violet-200 hover:text-white">nah-js and web frameworks</Link>.</p>
    </DocSection>
  </DocsShell>;
}
