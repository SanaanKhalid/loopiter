import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '../../components/site-chrome';
import { docsHref } from '../../lib/docs-links';

export const metadata: Metadata = {
  title: 'The Loopiter Manifesto — A correction should count',
  description: 'Someone took the time to tell you what went wrong. The next person should get a better answer. Why we’re building Loopiter.',
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
          <h1 id="manifesto-title">A correction<br />should count.</h1>
          <p className="manifesto-deck">Someone took the time to tell you what went wrong.<br className="desktop-break" /> The next person should get a better answer.</p>
        </header>

        <div className="manifesto-body">
          <p>A support agent gives the wrong warranty period. You correct it. It apologizes. A week later, another customer gets the same wrong answer.</p>
          <p>The correction fixed one conversation. Everything behind the answer stayed the same.</p>
          <p>Someone already knew what was wrong. They explained it. That should have been useful beyond the moment they said it.</p>

          <section aria-labelledby="after-launch">
            <h2 id="after-launch">The work starts after launch.</h2>
            <p>You can spend weeks choosing a model, writing a prompt, and getting a demo to behave. Then people use it. They ask questions you didn’t think of. They find gaps in your documentation. Your policy changes. A good answer from last month becomes a bad one.</p>
            <p>That’s normal. The trouble is what happens next. A correction lands in a support ticket, a chat, or a developer’s notes. Someone has to find it, work out what caused the mistake, change something, and check whether the change broke anything else.</p>
            <p>Useful feedback piles up while the agent keeps running.</p>
          </section>

          <section aria-labelledby="people-know">
            <h2 id="people-know">People know things your model doesn’t.</h2>
            <p>The person handling returns knows the exceptions. The engineer on call knows which warning matters. The customer can tell you exactly where an answer stopped being helpful.</p>
            <p>Some of that knowledge belongs in a prompt. Some belongs in the knowledge behind it. Some feedback needs a follow-up question before it belongs anywhere.</p>
            <p>We want to make it easier to use that knowledge. The person who spots a mistake should be able to explain it where they’re already working, with the original answer attached. A useful correction deserves a path into the application.</p>
          </section>

          <section aria-labelledby="earn-change">
            <h2 id="earn-change">A change has to earn its place.</h2>
            <p>A confident correction can still be wrong. Advice that fixes one answer can spoil ten others. An agent can agree with a customer and contradict the actual policy.</p>
            <p>So “it listened to the feedback” isn’t enough. Keep the original answer. Make a candidate change. Try it against the correction and the things the application already needs to get right. Compare the results.</p>
            <p>When the evidence is missing or the checks fail, keep the current version. When a change passes, record what changed and keep a way back. Those checks have limits, too. Passing your examples gives you evidence about those examples.</p>
          </section>

          <section aria-labelledby="keep-application">
            <h2 id="keep-application">You’ve already built an application.</h2>
            <p>You chose its models, connected its tools, and worked out what it’s allowed to do. Adding a feedback loop should fit that work.</p>
            <p>Loopiter’s job is to help improve the prompt and knowledge you choose to put in the loop. Your application keeps its credentials, permissions, and execution logic. You decide what must stay fixed, what can change, and how much it can spend.</p>
            <p>Setup should work the same way. Tell your coding agent what you want to connect. Let it work through the integration with you, in the project where the code lives.</p>
          </section>

          <section aria-labelledby="why-loopiter">
            <h2 id="why-loopiter">That’s why we’re building Loopiter.</h2>
            <p>We want the work people do to correct an agent to carry forward. A mistake should leave behind something useful: a clearer instruction, a missing fact, a test that catches it next time.</p>
            <p>There will still be bad answers. People will still need to check important work. But the same correction shouldn’t have to start from scratch every time.</p>
            <p className="manifesto-signoff">If someone teaches your application something worth keeping, it should have a way to keep it.</p>
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
