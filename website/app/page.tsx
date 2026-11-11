import type { Metadata } from 'next';
import Link from 'next/link';
import { HomeFaq } from '../components/home-faq';
import { SdkExample } from '../components/sdk-example';
import { SiteFrame } from '../components/site-chrome';
import { StartWithAgent } from '../components/start-with-agent';
import { docUrl, docsHref } from '../lib/docs-links';
import { pageMetadata } from '../lib/site';

export const metadata: Metadata = pageMetadata({
  title: 'Loopiter — Governed improvement for AI systems',
  description: 'Connect production AI behavior to verified outcomes, find recurring patterns, and turn evidence into governed improvements. MIT-licensed Python and Node.js SDKs.',
  path: '/',
});

const code = `import { FeedbackLoop, InMemoryStore } from "loopiter"

const loop = new FeedbackLoop({
  store: new InMemoryStore(), // development only
  namespace: "acme/dev",
})

const turn = await loop.recordExecution({
  kind: "agent",
  artifacts: { prompt: "support@18" },
})

await loop.recordSignal({
  executionId: turn.id,
  kind: "outcome",
  name: "resolved",
  value: true,
  source: "ticket-system",
})

await loop.close()
// Recommendations do not deploy automatically.`;

const pythonCode = `import asyncio
from loopiter import FeedbackLoop, InMemoryStore

async def main():
    loop = FeedbackLoop(
        store=InMemoryStore(),  # development only
        namespace="acme/dev",
    )
    turn = await loop.record_execution(
        kind="agent",
        artifacts={"prompt": "support@18"},
    )
    await loop.record_signal(
        execution_id=turn["id"],
        kind="outcome",
        name="resolved",
        value=True,
        source="ticket-system",
    )
    await loop.close()

asyncio.run(main())
# Recommendations do not deploy automatically.`;

const loopSteps = [
  ['01', 'Capture', 'Record executions and the prompt, model, and tool versions attached to them.'],
  ['02', 'Connect', 'Attach verified feedback, outcomes, and other signals to the execution they describe.'],
  ['03', 'Discover', 'Inspect recurring scored segments and the evidence counts behind them.'],
  ['04', 'Improve', 'Propose, evaluate, and deploy through your adapter, with a version you can roll back.'],
];

const targets = [
  'PROMPTS', 'ROUTING', 'RETRIEVAL', 'MODELS', 'DATASETS', 'THRESHOLDS',
  'TOOLS', 'WORKFLOWS', 'AGENT TOPOLOGY', 'CODE', 'CAPACITY',
];

export default function Home() {
  return (
    <main>
      <a className="skip-link" href="#how-it-works">Skip to content</a>
      <SiteFrame>
        <section className="hero grid-surface">
          <div className="hero-copy">
            <div className="eyebrow"><span>CONTROL PLANE</span> FOR CONTINUOUS AI IMPROVEMENT</div>
            <h1>AI systems that learn from what happens next.</h1>
            <p className="hero-lede">
              Loopiter connects production behavior to verified outcomes, finds recurring failure modes, and turns evidence into governed improvements.
            </p>
            <div className="hero-actions">
              <StartWithAgent />
              <a href={docsHref()} className="button button-ghost">READ THE DOCS <span>→</span></a>
              <a href="#how-it-works" className="button button-ghost">EXPLORE THE LOOP</a>
            </div>
            <p className="agent-start-hint">Paste into Codex or Claude Code. Set up through conversation.</p>
            <p className="hero-note">Native Python and Node.js SDKs. Keep your models, database, and deployment stack.</p>
          </div>

          <SdkExample pythonCode={pythonCode} nodeCode={code} />

          <div className="signal-path" aria-hidden="true">
            <span>EXECUTION</span><i />
            <span>OUTCOME</span><i />
            <span>FINDING</span><i />
            <span>CANDIDATE</span><i />
            <span>BETTER SYSTEM</span>
          </div>
        </section>

        <section className="section" id="how-it-works">
          <div className="section-heading">
            <div className="section-label">[ THE CORE LOOP ]</div>
            <h2>One feedback primitive.<br />Every AI system.</h2>
            <p>From an LLM support agent to a scored predictor, the mechanics are the same: observe a decision, connect the outcome, and improve only when the evidence survives evaluation.</p>
          </div>
          <div className="step-grid">
            {loopSteps.map(([number, title, body]) => (
              <article className="step-card" key={number}>
                <span className="step-number">{number}</span>
                <div className="step-icon" aria-hidden="true"><span /></div>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="architecture-section">
          <div className="architecture-copy">
            <div className="section-label">[ TRACE THE WHOLE SYSTEM ]</div>
            <h2>See the model, and everything around it.</h2>
            <p>Executions can form a tree. Record the root agent, delegated turns, retrievals, model calls, and tools inside one episode. The bottleneck might be a prompt. It might be a queue.</p>
            <a href={docsHref('execution-model')} className="text-link">EXPLORE THE EXECUTION MODEL <span>→</span></a>
          </div>
          <figure className="trace-diagram" aria-label="Illustrative hierarchical AI execution trace" style={{ margin: 0 }}>
            <div className="trace-root"><span className="node-dot hot" />ROOT AGENT<small>episode_1042</small></div>
            <div className="trace-children">
              <div className="trace-node"><span className="node-dot" />CLASSIFIER<small>124 ms</small></div>
              <div className="trace-node active"><span className="node-dot hot" />RESEARCH AGENT<small>1,840 ms</small></div>
              <div className="trace-node"><span className="node-dot" />RESPONSE<small>438 ms</small></div>
            </div>
            <div className="trace-tool"><span className="node-dot warn" />EXTERNAL LOOKUP<small>queue wait: 1,316 ms</small><b>BOTTLENECK</b></div>
            <figcaption className="trace-caption"><span />Illustrative trace · not measured customer results</figcaption>
          </figure>
        </section>

        <section className="section autonomy-section" id="autonomy">
          <div className="section-heading compact">
            <div className="section-label">[ AUTONOMY, GRADUATED ]</div>
            <h2>Choose how far the loop can go.</h2>
            <p>A fresh self-hosted plan records autonomous mode, with self-improving on. Your application calls each tick. The worker spends only when you pass --enable. Omit the mode on the controller and that object stays on recommend. Omit --mode on the worker and the run follows the plan.</p>
          </div>
          <div className="mode-list">
            <div className="mode-row"><span>01</span><strong>OBSERVE</strong><p>Inspect eligible evidence without proposing a change.</p><b>NO MUTATION</b></div>
            <div className="mode-row"><span>02</span><strong>RECOMMEND</strong><p>Store bounded proposals. Nothing is approved or deployed.</p><b>OMIT MODE</b></div>
            <div className="mode-row"><span>03</span><strong>EXPERIMENT</strong><p>Compare candidates and audit them. Callbacks run in your process.</p><b>AUDIT ONLY</b></div>
            <div className="mode-row selected"><span>04</span><strong>AUTONOMOUS</strong><p>Fresh init records this mode. Approve, apply, observe, retain, or roll back inside the policy.</p><b>FRESH INIT</b></div>
          </div>
          <div className="manifesto-next">
            <Link className="text-link" href="/blog/graduated-autonomy-for-self-improving-ai-agents">How graduated autonomy works <span aria-hidden="true">→</span></Link>
            <a className="text-link" href={docUrl('autonomous')}>Autonomy modes in the documentation <span aria-hidden="true">→</span></a>
          </div>
        </section>

        <section className="targets-section">
          <div className="section-label">[ CANDIDATE TYPES · DEPLOYED THROUGH YOUR ADAPTER ]</div>
          <div className="ticker" aria-label="Candidate target kinds">
            {targets.map((target) => <span key={target}>{target}<i>↗</i></span>)}
          </div>
        </section>

        <section className="safety-section" id="safety">
          <div>
            <div className="section-label">[ GOVERNED BY DEFAULT ]</div>
            <h2>Your evidence. Your policies. Your decision to deploy.</h2>
          </div>
          <div className="safety-grid">
            <article><span>01</span><h3>Explicit change boundaries</h3><p>A fresh plan records autonomous mode and self-improving on. The policy names an exact prompt or routing target, bounded fields, and daily budgets. Node may also name agent_release. The worker spends only with --enable.</p></article>
            <article><span>02</span><h3>Versioned evaluation</h3><p>Approval references the exact candidate, evidence, evaluator version, and passing evaluation.</p></article>
            <article><span>03</span><h3>Application-owned boundaries</h3><p>Keep authentication, authorization, tool allowlists, and evaluator code outside generated artifacts.</p></article>
            <article><span>04</span><h3>Recoverable deployment</h3><p>The SDK records the attempt, the receipt, and the predecessor so you can inspect and roll back.</p></article>
          </div>
        </section>

        <section className="section reading" aria-labelledby="manifesto-invitation-title">
          <div className="section-label">[ WHY WE ARE BUILDING LOOPITER ]</div>
          <h2 id="manifesto-invitation-title">Give feedback. Let it improve.</h2>
          <p className="manifesto-deck">Your agent should do the work between a useful correction and a better next answer. Test the change. Put it to work when it passes. Keep going.</p>
          <div className="manifesto-next">
            <Link className="text-link" href="/manifesto">Read the manifesto <span aria-hidden="true">→</span></Link>
            <Link className="text-link" href="/blog/self-improving-ai-agents-need-a-feedback-loop-you-can-evaluate">Why a feedback loop has to be evaluable <span aria-hidden="true">→</span></Link>
            <Link className="text-link" href="/blog/graduated-autonomy-for-self-improving-ai-agents">Graduated autonomy for self-improving agents <span aria-hidden="true">→</span></Link>
          </div>
        </section>

        <HomeFaq />

        <section className="final-cta grid-surface">
          <div className="loop-glyph" aria-hidden="true">↻</div>
          <div className="section-label">[ CLOSE THE LOOP ]</div>
          <h2>Your model is replaceable.<br />Your learning loop compounds.</h2>
          <p>Start with one execution, one outcome, and one recurring pattern.</p>
          <a href={docUrl('python')} className="button button-primary">GET STARTED WITH PYTHON <span>→</span></a>
        </section>
      </SiteFrame>
    </main>
  );
}
