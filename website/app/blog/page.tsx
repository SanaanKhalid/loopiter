import type { Metadata } from 'next';
import Link from 'next/link';
import { JsonLd } from '../../components/json-ld';
import { SiteFrame } from '../../components/site-chrome';
import { docUrl } from '../../lib/docs-links';
import { postPath, posts, publishedLabel } from '../../lib/posts';
import { pageMetadata } from '../../lib/site';
import { blogJsonLd } from '../../lib/structured-data';

export const metadata: Metadata = pageMetadata({
  title: 'Blog — Loopiter',
  description:
    'Notes on evaluation and feedback loops for AI agents, and how the Loopiter SDK implements them.',
  path: '/blog',
});

export default function BlogIndex() {
  return (
    <>
      <JsonLd data={blogJsonLd(posts)} />
      <a className="skip-link" href="#blog">Skip to content</a>
      <SiteFrame page="blog">
      <main id="blog" className="reading">
        <header className="manifesto-heading">
          <p className="eyebrow">Blog</p>
          <h1>Notes on feedback loops</h1>
          <p className="manifesto-deck">
            How evaluation, reflection, memory, and harnesses show up in practice, and what the Loopiter SDK in this repository does with them.
          </p>
        </header>
        <ol className="blog-list">
          {posts.map((post) => (
            <li key={post.slug}>
              <p className="blog-dates">
                <time dateTime={post.date}>{publishedLabel(post.date)}</time>
                {post.dateModified !== post.date ? (
                  <time dateTime={post.dateModified}>Updated {publishedLabel(post.dateModified)}</time>
                ) : null}
              </p>
              <h2><Link href={postPath(post.slug)}>{post.title}</Link></h2>
              <p>{post.description}</p>
            </li>
          ))}
        </ol>
        <div className="manifesto-next">
          <Link className="text-link" href="/">Loopiter home <span aria-hidden="true">↗</span></Link>
          <Link className="text-link" href="/manifesto">Read the manifesto <span aria-hidden="true">↗</span></Link>
          <a className="text-link" href={docUrl('overview')}>Read the documentation <span aria-hidden="true">↗</span></a>
        </div>
      </main>
      </SiteFrame>
    </>
  );
}
