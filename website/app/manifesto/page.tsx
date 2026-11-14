import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteFrame } from '../../components/site-chrome';
import { docUrl, docsHref } from '../../lib/docs-links';
import { pageMetadata } from '../../lib/site';

export const metadata: Metadata = pageMetadata({
  title: 'The Loopiter Manifesto — Agents improve themselves automatically.',
  description: 'Agents improve themselves automatically, while they\u2019re in use. Production signals drive tested changes to prompt and knowledge. A change ships only when held-out evidence shows it is better.',
  path: '/manifesto',
});

export default function Manifesto() {
  return <main>
    <a className="skip-link" href="#manifesto">Skip to content</a>
    <SiteFrame page="manifesto">
    <article id="manifesto" className="reading" aria-labelledby="manifesto-title">
        <header className="manifesto-heading">
          <p className="eyebrow">The Loopiter manifesto</p>
          <h1 id="manifesto-title">It improves itself,<br />while it&apos;s in use.</h1>
          <p className="manifesto-deck">Agents improve themselves automatically, while they&apos;re in use.</p>
        </header>

        <div className="manifesto-body">
          <p>A support agent tells a customer the warranty is one year. The order says two. The conversation ends, and the outcome is wrong.</p>
          <p>The next time that question comes up, nobody has to find the transcript, edit the prompt, and ship a patch. The miss is already a signal. The agent proposes a change to its prompt or knowledge, tests it on held-out cases, and ships it when the new version beats the one in use. The following customer gets two years.</p>

          <section aria-labelledby="default-is-improvement">
            <h2 id="default-is-improvement">Improvement is the default.</h2>
            <p>An agent should get better at its job while people are using it. That is the ordinary state, not a project someone starts later.</p>
            <p>Outcomes, failures, evaluations, and human feedback when someone gives it, all feed the same loop. The agent does not wait for a developer to notice. It keeps working between conversations.</p>
          </section>

          <section aria-labelledby="agent-does-the-work">
            <h2 id="agent-does-the-work">The agent does the work.</h2>
            <p>It looks at what happened, decides whether a change is worth trying, and proposes a small update to its prompt or knowledge. Then it tests that update against the cases it must still get right.</p>
            <p>When the evidence says the change is better, it ships. Later answers use the new version. What changed is on the record.</p>
          </section>

          <section aria-labelledby="evidence-is-the-gate">
            <h2 id="evidence-is-the-gate">Evidence is the gate.</h2>
            <p>A change goes live only when held-out evidence shows it beats the current version. Otherwise the current version stays, and the reason is recorded.</p>
            <p>A promising draft that loses the comparison is not an improvement. The gate is what makes automatic shipping something you can trust: the agent can move, and it cannot move a change that failed the test.</p>
          </section>

          <section aria-labelledby="the-bar-stays-fixed">
            <h2 id="the-bar-stays-fixed">The bar is set once.</h2>
            <p>Humans set the fixed instructions, the examples that must keep passing, and the budget. The agent works inside that bar. It cannot rewrite its own checks to make a change pass.</p>
            <p>Those limits are the safety of full autonomy. They are set so the loop can run, not so someone has to approve each edit.</p>
          </section>

          <section aria-labelledby="every-change-can-return">
            <h2 id="every-change-can-return">Every change can be undone.</h2>
            <p>Every released change has a history and a previous version that can be restored. Rollback is part of shipping on its own.</p>
            <p className="manifesto-signoff">While it is in use, it gets better.</p>
          </section>
        </div>

        <div className="manifesto-next">
          <Link className="text-link" href="/#how-it-works">How Loopiter works <span aria-hidden="true">↗</span></Link>
          <Link className="text-link" href="/blog/self-improving-ai-agents-need-a-feedback-loop-you-can-evaluate">Why the loop has to be evaluable <span aria-hidden="true">↗</span></Link>
          <Link className="text-link" href="/blog/graduated-autonomy-for-self-improving-ai-agents">Graduated autonomy for self-improving agents <span aria-hidden="true">↗</span></Link>
          <a className="text-link" href={docUrl('autonomous')}>Autonomy modes in the documentation <span aria-hidden="true">↗</span></a>
          <a className="text-link" href={docsHref()}>Read the documentation <span aria-hidden="true">↗</span></a>
        </div>
    </article>
    </SiteFrame>
  </main>;
}
