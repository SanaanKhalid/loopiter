import { StartWithAgent } from '../components/start-with-agent';
import { docsHref } from '../lib/docs-links';

const github = 'https://github.com/SanaanKhalid/loopiter';

function LoopMark() {
  return <svg width="31" height="25" viewBox="0 0 38 28" fill="none" aria-hidden="true"><path d="M24 6a10 10 0 1 1 0 16L14 6a10 10 0 1 0 0 16" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>;
}

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
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Loopiter home"><LoopMark /><span>loopiter</span></a>
        <nav aria-label="Main navigation"><a className="nav-about" href="#how-it-works">The idea</a><a className="nav-link" href="https://web-loopiter-prod.redmushroom-e2f381a3.centralus.azurecontainerapps.io/login">Sign in</a><a className="nav-link" href={github}>Explore the SDK <span aria-hidden="true">↗</span></a></nav>
      </header>
      <div className="hero-copy">
        <p className="availability"><span /> In development</p>
        <h1 id="hero-title">AI that learns<br />from every correction.</h1>
        <p className="hero-description">Turn real feedback into better prompts and knowledge.<br className="desktop-break" /> Keep your agent. Close the loop.</p>
        <StartWithAgent />
      </div>
      <div className="hero-bottom"><span>Your agent. Your models. A better next answer.</span><span className="scroll-note">A continuous feedback loop <span aria-hidden="true">↓</span></span></div>
    </section>

    <section id="how-it-works" className="explanation" aria-labelledby="idea-title">
      <div className="intro"><h2 id="idea-title">Good feedback shouldn’t<br />end a conversation.</h2><p>It should improve the next one. Loopiter connects what your agent gets wrong to the prompts and knowledge behind its answers.</p></div>
      <ol className="steps">
        <li><span className="step-number">01</span><h3>Start in your coding agent.</h3><p>Paste the setup prompt into Codex or Claude Code. It inspects your project, or helps you build a new one, and asks what good results look like.</p></li>
        <li><span className="step-number">02</span><h3>Build the connection.</h3><p>Your coding agent integrates Loopiter, connects the evaluation worker, and tests the flow. Agree on your rules and examples through conversation.</p></li>
        <li><span className="step-number">03</span><h3>See it in your dashboard.</h3><p>Inspect responses, submit corrections, and follow tested improvements. Loopiter activates changes that pass your checks, with a version to roll back to.</p></li>
      </ol>
      <div className="closing"><p>We’re building this in the open.<br /><span>The platform is in development. The SDK is yours to explore.</span></p><a className="text-link" href={docsHref()}>Read the documentation <span aria-hidden="true">↗</span></a></div>
    </section>
    <footer><a className="brand footer-brand" href="#top"><LoopMark /><span>loopiter</span></a><span>Better, with every loop.</span><a href={github}>GitHub</a></footer>
  </main>;
}
