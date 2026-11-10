import type { Metadata } from 'next';
import { JsonLd } from '../../../components/json-ld';
import { OfflineBenchmarkArticle } from '../../../components/offline-benchmark-article';
import { SiteFrame } from '../../../components/site-chrome';
import { postPath, requirePost } from '../../../lib/posts';
import { pageMetadata } from '../../../lib/site';
import { articleJsonLd, breadcrumbJsonLd } from '../../../lib/structured-data';

const post = requirePost('evaluate-self-improving-ai-agents-offline');

export const metadata: Metadata = pageMetadata({
  title: `${post.title} — Loopiter`,
  description: post.description,
  path: postPath(post.slug),
  published: post.date,
  modified: post.dateModified,
});

export default function OfflineBenchmarkPost() {
  return (
    <>
      <JsonLd data={articleJsonLd(post)} />
      <JsonLd data={breadcrumbJsonLd(post)} />
      <a className="skip-link" href="#post-title">Skip to content</a>
      <SiteFrame page="blog">
        <main className="reading">
          <OfflineBenchmarkArticle post={post} />
        </main>
      </SiteFrame>
    </>
  );
}
