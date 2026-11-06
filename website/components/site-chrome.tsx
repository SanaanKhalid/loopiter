import type { ReactNode } from 'react';
import Link from 'next/link';
import { docsHref } from '../lib/docs-links';

const github = 'https://github.com/SanaanKhalid/loopiter';
const signIn = 'https://web-loopiter-prod.redmushroom-e2f381a3.centralus.azurecontainerapps.io/login';

export function Mark() {
  return (
    <span className="mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

export function SiteHeader({ page = 'home' }: { page?: 'home' | 'manifesto' | 'blog' | 'docs' }) {
  const home = page === 'home';
  return (
    <header className="site-header">
      <Link href="/" className="brand" aria-label="Loopiter home">
        <Mark />
        <span>Loopiter</span>
      </Link>
      <nav className="main-nav" aria-label="Main navigation">
        <Link href={home ? '#how-it-works' : '/#how-it-works'}>How it works</Link>
        <Link href={home ? '#autonomy' : '/#autonomy'}>Autonomy</Link>
        <Link href={home ? '#safety' : '/#safety'}>Safety</Link>
        <Link href="/blog" aria-current={page === 'blog' ? 'page' : undefined}>Blog</Link>
        <Link href="/manifesto" aria-current={page === 'manifesto' ? 'page' : undefined}>Manifesto</Link>
      </nav>
      <a href={docsHref()} className="nav-cta">
        DOCS <span aria-hidden="true">↗</span>
      </a>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <Link href="/" className="brand" aria-label="Loopiter home"><Mark /><span>Loopiter</span></Link>
      <p>A lightweight control plane for measurable AI improvement.</p>
      <div>
        <Link href="/blog">Blog</Link>
        <Link href="/manifesto">Manifesto</Link>
        <a href={docsHref()}>Docs</a>
        <a href="https://loopiter.co/llms.txt">llms.txt</a>
        <a href={github}>GitHub</a>
        <a href={signIn}>Sign in</a>
        <span>v0.3.0-alpha.1</span>
      </div>
    </footer>
  );
}

export function SiteFrame({ page = 'home', children }: { page?: 'home' | 'manifesto' | 'blog' | 'docs'; children: ReactNode }) {
  return (
    <>
      <div className="announcement">
        <span className="pulse-dot" />
        MIT-LICENSED ALPHA · MODEL-AGNOSTIC · ZERO CORE RUNTIME DEPENDENCIES
      </div>
      <div className="page-shell">
        <SiteHeader page={page} />
        {children}
        <SiteFooter />
      </div>
    </>
  );
}
