'use client';
import Link from 'next/link';
import { useEffect } from 'react';
import { SiteFrame } from '../../components/site-chrome';
import { docsHref } from '../../lib/docs-links';
export default function DocsRedirect() {
  useEffect(() => { window.location.replace(docsHref(window.location.hash)); }, []);
  return <main>
    <a className="skip-link" href="#docs-moved">Skip to content</a>
    <SiteFrame page="docs">
      <div id="docs-moved" className="redirect-page">
        <h1>Loopiter documentation has moved.</h1>
        <p><a href={docsHref()}>Continue to the canonical Fern documentation →</a></p>
        <p><Link href="/">Loopiter home</Link> · <Link href="/blog">Blog</Link></p>
      </div>
    </SiteFrame>
  </main>;
}
