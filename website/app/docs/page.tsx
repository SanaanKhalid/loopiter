'use client';
import Link from 'next/link';
import { useEffect } from 'react';
import { docsHref } from '../../lib/docs-links';
export default function DocsRedirect() {
  useEffect(() => { window.location.replace(docsHref(window.location.hash)); }, []);
  return <main className="page-shell"><h1>Loopiter documentation has moved.</h1><p><a href={docsHref()}>Continue to the canonical Fern documentation →</a></p><p><Link href="/">Loopiter home</Link> · <Link href="/blog">Blog</Link></p></main>;
}
