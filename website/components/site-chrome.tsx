const github = 'https://github.com/SanaanKhalid/loopiter';

function LoopMark() {
  return <svg width="31" height="25" viewBox="0 0 38 28" fill="none" aria-hidden="true"><path d="M24 6a10 10 0 1 1 0 16L14 6a10 10 0 1 0 0 16" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>;
}

export function SiteHeader({ page = 'home' }: { page?: 'home' | 'manifesto' }) {
  return <header className={`site-header${page === 'manifesto' ? ' paper-header' : ''}`}>
    <a className="brand" href="/" aria-label="Loopiter home"><LoopMark /><span>loopiter</span></a>
    <nav aria-label="Main navigation">
      <a className="nav-about" href={page === 'home' ? '#how-it-works' : '/#how-it-works'}>The idea</a>
      <a className="nav-manifesto" href="/manifesto" aria-current={page === 'manifesto' ? 'page' : undefined}>Manifesto</a>
      <a className="nav-link" href="https://web-loopiter-prod.redmushroom-e2f381a3.centralus.azurecontainerapps.io/login">Sign in</a>
      <a className="nav-link nav-sdk" href={github}>Explore the SDK <span aria-hidden="true">↗</span></a>
    </nav>
  </header>;
}

export function SiteFooter() {
  return <footer>
    <a className="brand footer-brand" href="/" aria-label="Loopiter home"><LoopMark /><span>loopiter</span></a>
    <span>Better, with every loop.</span>
    <nav className="footer-links" aria-label="Footer navigation"><a href="/manifesto">Manifesto</a><a href={github}>GitHub <span aria-hidden="true">↗</span></a></nav>
  </footer>;
}
