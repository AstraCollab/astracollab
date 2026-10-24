import Link from "next/link";
import { ArrowDown, ArrowRight, ArrowUpRight, Braces, Check, CircleStop, Code2, Eye, GitBranch, Gauge, LockKeyhole, MessageSquareText, Play, RotateCcw, Terminal, Wrench } from "lucide-react";
import { SiteFooter, SiteNav } from "@/components/SiteNav";

const steps = [
  { n: "01", icon: MessageSquareText, title: "Give it a task", body: "A prompt, working directory, and system instructions become the run’s starting context. The agent receives only the tools and limits your app gives it." },
  { n: "02", icon: Braces, title: "The model chooses", body: "The model can respond with an explanation or request a tool. Each response is one bounded step in a loop your application can observe." },
  { n: "03", icon: Wrench, title: "Tools do the work", body: "Read, search, edit, and shell tools run in your environment. Mutating actions can pause for your approval before anything changes." },
  { n: "04", icon: RotateCcw, title: "Results guide the next step", body: "Tool output returns to the model as context. It can inspect the result, choose another action, or finish with a final answer." },
];

export function HowItWorksPage() {
  return <main className="how-page">
    <SiteNav />
    <section className="how-hero">
      <div className="how-grid" />
      <div className="how-hero-copy">
        <div className="eyebrow"><i className="pulse"/> THE AGENT LOOP, MADE VISIBLE</div>
        <h1>From a prompt<br/>to <span>real work.</span></h1>
        <p>nah gives a model a task, a bounded set of tools, and a clear path to act. Every step returns through an explicit loop you can inspect, shape, and stop.</p>
        <div className="hero-actions"><Link className="button button-primary" href="/docs/agent-loop">Explore the agent loop <ArrowUpRight size={14}/></Link><Link className="button button-quiet" href="/framework">Meet the framework <ArrowRight size={14}/></Link></div>
        <div className="how-meta"><span><Check/> TypeScript first</span><span><Check/> Streamed events</span><span><Check/> You own the controls</span></div>
      </div>
      <div className="loop-visual" aria-label="Diagram of the agent loop">
        <div className="loop-orbit loop-orbit-a"/><div className="loop-orbit loop-orbit-b"/>
        <div className="loop-center"><span>nah</span><small>AGENT RUN</small></div>
        <div className="loop-chip chip-prompt"><MessageSquareText/><b>YOUR TASK</b><small>prompt + context</small></div>
        <div className="loop-chip chip-model"><Braces/><b>MODEL</b><small>decide next step</small></div>
        <div className="loop-chip chip-tool"><Wrench/><b>TOOLS</b><small>act in environment</small></div>
        <div className="loop-chip chip-events"><Eye/><b>EVENTS</b><small>observe the run</small></div>
        <div className="loop-legend"><span><i/>control stays in your app</span><span>01 — 04 / REPEATS UNTIL DONE</span></div>
      </div>
    </section>

    <section className="how-loop-section">
      <div className="how-section-heading"><div className="eyebrow">THE SHAPE OF A RUN</div><h2>A loop you can follow.</h2><p>Each model decision and tool outcome is an explicit part of the run. Nothing disappears behind a one-shot “agent” call.</p></div>
      <div className="run-map">
        <div className="run-main">
          <div className="run-map-top"><span><Play/> RUN 8F31 / CODING AGENT</span><span className="run-state"><i/> IN PROGRESS</span></div>
          <div className="run-flow">
            <article><b className="run-index">01</b><div><small>INPUT</small><strong>“Fix the failing test”</strong><p>Prompt + repository context enter the run.</p></div><span className="run-tag">prompt</span></article>
            <div className="run-line"><ArrowDown/></div>
            <article><b className="run-index purple">02</b><div><small>MODEL STEP</small><strong>Inspect the test and implementation</strong><p>The model requests a read operation.</p></div><span className="run-tag tag-model">text → tool</span></article>
            <div className="run-line"><ArrowDown/></div>
            <article><b className="run-index blue">03</b><div><small>TOOL RESULT</small><strong>Test output points to a mismatch</strong><p>Structured results become the next model context.</p></div><span className="run-tag tag-tool">tool-result</span></article>
            <div className="run-line loop-back"><RotateCcw/><span>continues with new context</span></div>
            <article><b className="run-index gold">04</b><div><small>APPROVAL GATE</small><strong>Review a proposed file edit</strong><p>Your policy decides whether the action can proceed.</p></div><span className="run-tag tag-review">approval</span></article>
            <div className="run-line"><ArrowDown/></div>
            <article><b className="run-index">05</b><div><small>FINISH</small><strong>Change verified, summary returned</strong><p>Final answer and usage are available to your app.</p></div><span className="run-tag tag-done"><Check/> done</span></article>
          </div>
          <div className="run-map-bottom"><span><i/> event stream connected</span><span>5 STEPS <b>·</b> 2 TOOL CALLS <b>·</b> 1 APPROVAL</span></div>
        </div>
        <aside className="run-side">
          <div className="side-card"><div className="side-card-icon"><LockKeyhole/></div><small>CONTROL POINT</small><h3>Tools have boundaries.</h3><p>Give an agent specific capabilities. Add an approval callback for actions that change files or run commands.</p><div className="approval-mini"><span>edit</span><span className="approval-pending">awaiting approval</span></div><div className="approval-actions"><b><Check/> approve</b><b>deny</b></div></div>
          <div className="side-card budget-card"><div className="side-card-icon"><Gauge/></div><small>RUN LIMITS</small><h3>Every run has a finish line.</h3><p>Bound steps, spend, and context. Inspect usage and stop reasons when the run completes.</p><div className="budget-row"><span>SPEND</span><b>$0.08 <small>/ $0.50</small></b></div><div className="budget-bar"><i/></div><div className="budget-foot"><span><CircleStop/> max steps: 12</span><span>16%</span></div></div>
        </aside>
      </div>
    </section>

    <section className="how-steps-section">
      <div className="how-section-heading"><div className="eyebrow">FOUR MOVING PARTS</div><h2>Small steps. Clear ownership.</h2><p>Your application sets the boundaries; the loop carries context from one decision to the next.</p></div>
      <div className="how-steps">{steps.map(({ n, icon: Icon, title, body }) => <article key={n}><div className="step-top"><span>{n}</span><Icon/></div><h3>{title}</h3><p>{body}</p><div className="step-line"><i/></div></article>)}</div>
    </section>

    <section className="how-code-section">
      <div className="code-copy"><div className="eyebrow">AN EXPLICIT API</div><h2>Wire the loop into your product.</h2><p>Use the framework when you want to compose the agent yourself. Stream events into your UI, connect approvals to your policy, and keep the run result in your hands.</p><Link href="/framework" className="text-link">Explore the framework <ArrowRight/></Link></div>
      <div className="how-code-window"><div className="how-code-head"><span><i/><i/><i/> <b>agent.ts</b></span><small>YOUR APP · TYPESCRIPT</small></div><pre><code><em>const</em> run = <u>runAgent</u>({'{'}
  model,
  prompt: <strong>"Fix the failing test"</strong>,
  system: buildSystemPrompt(cwd),
  tools: createCodingTools(env, {'{'}
    approveToolCall: askForApproval,
  {'}' }),
  maxSteps: <i>12</i>,
  maxSpendUsd: <i>0.50</i>,
{'}'});

<em>for await</em> (<em>const</em> event <em>of</em> run.events) {'{'}
  renderRunEvent(event);
{'}'}
<em>const</em> result = <em>await</em> run.result;</code></pre><div className="how-code-foot"><span><i/> stream each step to your UI</span><span>events → result</span></div></div>
    </section>

    <section className="how-tools-section"><div className="how-section-heading"><div className="eyebrow">ONE RUNTIME, MORE WAYS TO BUILD</div><h2>Start where you are.</h2><p>Build a custom agent, use nah as your coding partner, or inspect the work as it happens.</p></div><div className="how-tool-cards">
      <Link href="/framework"><Braces/><small>01 / BUILD</small><h3>Framework</h3><p>Compose model steps, tools, approvals, and events into your own product.</p><span>Build with the SDK <ArrowUpRight/></span></Link>
      <Link href="/agent"><Terminal/><small>02 / USE</small><h3>NAH Agent</h3><p>Put the same explicit loop to work on real code from your terminal.</p><span>Meet the agent <ArrowUpRight/></span></Link>
      <Link href="/studio"><Eye/><small>03 / INSPECT</small><h3>Studio</h3><p>See runs, tool activity, and traces in a workspace built for visibility.</p><span>Explore Studio <ArrowUpRight/></span></Link>
    </div></section>
    <section className="how-end"><div className="eyebrow">READY TO BUILD?</div><h2>Make the loop yours.</h2><p>Start with the agent loop guide, then shape the run around your product and your users.</p><div className="hero-actions"><Link className="button button-primary" href="/docs/installation">Get started <ArrowUpRight size={14}/></Link><Link className="button button-quiet" href="/docs/events">Read about events <Code2 size={14}/></Link></div></section>
    <SiteFooter/>
  </main>;
}
