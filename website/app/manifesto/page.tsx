import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '../../components/site-chrome';
import { docsHref } from '../../lib/docs-links';

export const metadata: Metadata = {
  title: 'The Loopiter Manifesto — Give feedback. Let it improve.',
  description: 'Your agent should turn useful feedback into tested prompt and knowledge improvements, then put passing changes to work automatically. Why we’re building Loopiter.',
  alternates: { canonical: 'https://loopiter.co/manifesto' },
};

export default function Manifesto() {
  return <>
    <a className="skip-link" href="#manifesto">Skip to content</a>
    <SiteHeader page="manifesto" />
    <main id="manifesto" className="manifesto-page">
      <article aria-labelledby="manifesto-title">
        <header className="manifesto-heading">
          <p className="eyebrow">The Loopiter manifesto</p>
          <h1 id="manifesto-title">Give feedback.<br />Let it improve.</h1>
          <p className="manifesto-deck">Your agent should turn a useful correction into a tested improvement, without waiting for someone to rewrite its prompt.</p>
        </header>

        <div className="manifesto-body">
          <p>A support agent gives the wrong warranty period. You correct it. It apologizes. A week later, another customer gets the same wrong answer.</p>
          <p>You already explained the mistake. Now someone has to find that conversation, figure out what to change, edit the prompt or knowledge, run the checks, and ship an update.</p>
          <p>We think an agent should be able to carry that work through. You give the feedback. It works on making the next answer better.</p>

          <section aria-labelledby="feedback-starts-work">
            <h2 id="feedback-starts-work">Feedback should start the work.</h2>
            <p>The person handling returns knows the exceptions. The engineer on call knows which warning matters. The customer can tell you exactly where an answer stopped being helpful.</p>
            <p>That knowledge usually arrives as a correction, in the middle of someone’s day. It shouldn’t need a separate project before the application can use it.</p>
            <p>Attach the feedback to the answer it’s about. Give the agent enough context to understand what went wrong. That should be enough to start an improvement attempt.</p>
          </section>

          <section aria-labelledby="finish-the-job">
            <h2 id="finish-the-job">Let the agent finish the job.</h2>
            <p>It should examine the original answer and the feedback, work out whether a change is needed, and propose a small update to its prompt or knowledge. Then it should test that update against the correction and the things it already needs to get right.</p>
            <p>When the checks pass and the change improves on the current version, it should go live automatically. Future answers should use the improved version. You should be able to see what happened without having to move every change through by hand.</p>
            <p>This is the loop we’re building: feedback comes in, the agent does the improvement work, and passing changes become part of the application. Once you enable it, that work can continue between your visits.</p>
          </section>

          <section aria-labelledby="set-the-rules">
            <h2 id="set-the-rules">You decide what good means.</h2>
            <p>You set the instructions that must stay fixed, the examples that must keep working, and the budget for improvement. The agent works within those limits. It doesn’t get to rewrite its own checks to make a change pass.</p>
            <p>A vague complaint may need more information. A correction may conflict with an earlier one. A promising change may fail a regression. In those cases, the current version stays in place and the reason is recorded.</p>
            <p>Passing checks is evidence about the cases you tested. Keep improving those checks as you learn. Every released change should have a history you can inspect and a previous version you can restore.</p>
          </section>

          <section aria-labelledby="keep-application">
            <h2 id="keep-application">You’ve already built an application.</h2>
            <p>You chose its models, connected its tools, and worked out what it’s allowed to do. Adding a feedback loop should fit that work.</p>
            <p>Loopiter automates improvement of the prompt and knowledge you put in the loop. Your application keeps its credentials, permissions, and execution logic. You choose the part that can improve on its own.</p>
            <p>Setup should work the same way. Tell your coding agent what you want to connect. Let it work through the integration with you, in the project where the code lives.</p>
          </section>

          <section aria-labelledby="why-loopiter">
            <h2 id="why-loopiter">That’s why we’re building Loopiter.</h2>
            <p>We want an agent to get better at its job while it’s being used. People supply the feedback and define what a good answer looks like. The agent takes on the work of turning that feedback into a change worth keeping.</p>
            <p>A useful correction should leave the application better prepared for the next person, even when no developer is sitting there to make the edit.</p>
            <p className="manifesto-signoff">Give the feedback. Let the agent do the follow-through.</p>
          </section>
        </div>

        <div className="manifesto-next">
          <a className="text-link" href="/#how-it-works">How Loopiter works <span aria-hidden="true">↗</span></a>
          <a className="text-link" href={docsHref()}>Read the documentation <span aria-hidden="true">↗</span></a>
        </div>
      </article>
    </main>
    <SiteFooter />
  </>;
}
