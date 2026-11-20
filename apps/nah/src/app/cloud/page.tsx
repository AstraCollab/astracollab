import Link from "next/link";
import { ArrowRight, Check, Cloud, Command, FileCode2, Shield, Sparkles, Terminal, Workflow } from "lucide-react";
import { SiteFooter, SiteNav } from "@/components/SiteNav";

function Feature({ icon: Icon, title, body }: { icon: any; title: string; body: string }) { return <article className="cloud-feature"><span><Icon/></span><div><h3>{title}</h3><p>{body}</p></div></article>; }

function CodeBlock({ children }: { children: React.ReactNode }) { return <div className="cloud-code"><pre><code>{children}</code></pre></div>; }

export default function CloudPage() { return <main className="cloud-page"><SiteNav/><section className="cloud-hero"><div className="hero-grid"/><div className="cloud-glow"/><div className="cloud-page-content"><Link href="/" className="back-link"><ArrowRight size={14} direction="left"/> NAH toolkit</Link><div className="eyebrow"><span className="cloud-dot"/> NAH CLOUD · LIVE</div><h1>Your agents,<br/><span>hosted.</span></h1><p className="hero-copy">nah-cloud is the hosted control plane for agents built with the open NAH runtime. Connect your terminal, Cursor, Claude Code, or VS Code over MCP and run agents in hosted sandboxes — metered, billed, and traced.</p><div className="cloud-status"><span className="status-orb"><Cloud/></span><span><b>Live</b><small>MCP server at cloud.nah-ai.com/api/mcp</small></span></div><div className="cloud-actions"><Link href="/docs/installation" className="button button-primary">Get started with nah<ArrowRight size={13}/></Link><Link href="/cloud#connect" className="button button-quiet">Connect an MCP client<ArrowRight size={13}/></Link></div></div></section><section className="cloud-features"><div className="cloud-section-head"><h2>What you get</h2><p>One endpoint, every agent capability — billed per call, capped per month.</p></div><div className="cloud-feature-grid"><Feature icon={Terminal} title="Hosted sandboxes" body="`sandbox.create` forks a machine from your organization’s template; `sandbox.exec`, `sandbox.files.*`, and `sandbox.status` operate it. Runs stop billing when they stop."/><Feature icon={Workflow} title="Agent runs" body="`agent.run` starts a nah agent in a sandbox; `agent.trace` reads its trace and spans; `agent.cancel` interrupts it. Every call is a trace in your org’s dashboard."/><Feature icon={Shield} title="Org-scoped access" body="Every MCP call authenticates with an organization API key. Tool enablement, spend ceilings, and per-run caps are set per organization — no client can call another org’s tools."/><Feature icon={Sparkles} title="Metered by call" body="Flat cents per tool call ($5 sandbox, $0.50 command, $10 agent run). Set a monthly spend ceiling per org; calls that would exceed it are refused before they run."/></div></section><section className="cloud-connect" id="connect"><div className="cloud-section-head"><h2>Connect an MCP client</h2><p>nah-cloud speaks Streamable HTTP at `https://cloud.nah-ai.com/api/mcp`. Auth is OAuth 2.1 authorization code flow with PKCE.</p></div><div className="cloud-connect-grid"><div className="cloud-step-col"><h3>1. Register a client</h3><CodeBlock>{`POST https://cloud.nah-ai.com/api/mcp/oauth/client
{
  "client_name": "My Claude Code",
  "redirect_uris": ["http://localhost:3000/mcp/cb"]
}`}</CodeBlock><p className="cloud-note">Signed-in user with an organization. `client_secret` is shown once.</p></div><div className="cloud-step-col"><h3>2. Authorize</h3><CodeBlock>{`GET https://cloud.nah-ai.com/api/mcp/oauth/authorize
?response_type=code&client_id=...&redirect_uri=...&scope=mcp
&code_challenge=...&code_challenge_method=S256&state=...`}</CodeBlock><p className="cloud-note">The user signs in and approves; nah-cloud redirects back with a one-time `code`.</p></div><div className="cloud-step-col"><h3>3. Exchange for a token</h3><CodeBlock>{`POST https://cloud.nah-ai.com/api/mcp/oauth/token
grant_type=authorization_code&code=...&client_id=...&client_secret=...&code_verifier=...`}</CodeBlock><p className="cloud-note">Returns an `access_token` — a nah organization API key bound to that org.</p></div><div className="cloud-step-col"><h3>4. Call tools</h3><CodeBlock>{`curl -X POST https://cloud.nah-ai.com/api/mcp \\
  -H "authorization: Bearer <access_token>" \\
  -H "content-type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",...}'`}</CodeBlock><p className="cloud-note">Echo the `mcp-session-id` from `initialize` on every call.</p></div></div></section><section className="cloud-nah-cli"><div className="cloud-section-head"><h2>Or use nah directly</h2><p>No separate client needed — connect a session to cloud from the CLI:</p></div><div className="cloud-cli-grid"><CodeBlock>{`# Register once
nah mcp connect mycloud https://cloud.nah-ai.com/api/mcp

# Connect a session
nah --mcp https://cloud.nah-ai.com/api/mcp

# Inside a session
/mcp connect https://cloud.nah-ai.com/api/mcp
/mcp tools mycloud
/mcp tool sandbox.exec '{"sandboxId":"...","command":"ls"}'`}</CodeBlock><p className="cloud-note">The bearer token is saved to your platform credential store (Keychain, Secret Service, DPAPI) — never on the command line. A bare `nah` with no `--mcp` behaves exactly as before: local-only, no network.</p></div></section><div className="cloud-footnote"><Check/> The framework (`not-another-harness`) and local Studio are available today. <Link href="/">Explore the toolkit <ArrowRight size={13}/></Link></div><SiteFooter/></main>; }
