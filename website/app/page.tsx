import { docsHref } from '../lib/docs-links';
import { SiteFooter, SiteHeader } from '../components/site-chrome';

function LoopArtwork() {
  return <svg className="loop-art" viewBox="0 0 1400 950" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id="thread" x1="280" y1="50" x2="1100" y2="900" gradientUnits="userSpaceOnUse"><stop stopColor="#d7ece0" stopOpacity=".75"/><stop offset=".48" stopColor="#9cbdb0" stopOpacity=".1"/><stop offset="1" stopColor="#8da99c" stopOpacity=".65"/></linearGradient>
      <radialGradient id="light"><stop stopColor="#adc9b9" stopOpacity=".21"/><stop offset="1" stopColor="#adc9b9" stopOpacity="0"/></radialGradient>
    </defs>
    <ellipse cx="1020" cy="320" rx="580" ry="480" fill="url(#light)"/>
    <g transform="rotate(-27 700 475)" stroke="url(#thread)" strokeWidth="1">
      {Array.from({length: 30}, (_, i) => <ellipse key={i} cx="700" cy="475" rx={330 + i * 7} ry={145 + i * 7} />)}
    </g>
    <circle cx="1052" cy="218" r="6" fill="#ddebc7"/>
    <circle cx="1052" cy="218" r="15" stroke="#ddebc7" strokeOpacity=".25"/>
  </svg>;
}

export default function Home() {
  return <main id="top">
    <a className="skip-link" href="#how-it-works">Skip to content</a>
    <section className="hero" aria-labelledby="hero-title">
      <LoopArtwork />
      <SiteHeader />
      <div className="hero-copy">
        <p className="availability"><span /> In development</p>
        <h1 id="hero-title">AI that learns<br />from every correction.</h1>
        <p className="hero-description">Turn real feedback into better prompts and knowledge.<br className="desktop-break" /> Keep your agent. Close the loop.</p>
        <a className="button" href="#how-it-works">Meet Loopiter <span aria-hidden="true">↓</span></a>
      </div>
      <div className="hero-bottom"><span>Your agent. Your models. A better next answer.</span><span className="scroll-note">A continuous feedback loop <span aria-hidden="true">↓</span></span></div>
    </section>

    <section id="how-it-works" className="explanation" aria-labelledby="idea-title">
      <div className="intro"><h2 id="idea-title">Good feedback shouldn’t<br />end a conversation.</h2><p>It should improve the next one. Loopiter connects what your agent gets wrong to the prompts and knowledge behind its answers.</p></div>
      <ol className="steps">
        <li><span className="step-number">01</span><h3>Bring your agent.</h3><p>Connect your existing application through the API or SDK. Keep the models and tools you already use.</p></li>
        <li><span className="step-number">02</span><h3>Close the loop.</h3><p>Send corrections from wherever your users respond. Loopiter looks for a useful change to the prompt or knowledge.</p></li>
        <li><span className="step-number">03</span><h3>Improve with evidence.</h3><p>Loopiter tests changes against your examples and automatically activates improvements that pass, with a version to roll back to.</p></li>
      </ol>
      <div className="closing"><p>We’re building this in the open.<br /><span>The platform is in development. The SDK is yours to explore.</span></p><a className="text-link" href={docsHref()}>Read the documentation <span aria-hidden="true">↗</span></a></div>
    </section>
    <section className="manifesto-invitation" aria-labelledby="manifesto-invitation-title">
      <p className="eyebrow">Why we’re building Loopiter</p>
      <h2 id="manifesto-invitation-title">Someone took the time<br />to tell you what went wrong.</h2>
      <p>The next person should get a better answer. That’s the whole reason we’re here.</p>
      <a className="text-link" href="/manifesto">Read our manifesto <span aria-hidden="true">↗</span></a>
    </section>
    <SiteFooter />
  </main>;
}
