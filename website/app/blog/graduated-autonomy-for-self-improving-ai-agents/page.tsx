import type { Metadata } from 'next';
import { GraduatedAutonomyArticle } from '../../../components/graduated-autonomy-article';
import { JsonLd } from '../../../components/json-ld';
import { SiteFrame } from '../../../components/site-chrome';
import { routeLastModified } from '../../../lib/last-modified';
import { postPath, requirePost } from '../../../lib/posts';
import { pageMetadata } from '../../../lib/site';
import { articleJsonLd, breadcrumbJsonLd } from '../../../lib/structured-data';

const post = requirePost('graduated-autonomy-for-self-improving-ai-agents');
const modified = routeLastModified(postPath(post.slug), post.date);

export const metadata: Metadata = pageMetadata({
  title: `${post.title} — Loopiter`,
  description: post.description,
  path: postPath(post.slug),
  published: post.date,
  modified,
});

export default function GraduatedAutonomyPost() {
  return (
    <>
      <JsonLd data={articleJsonLd(post, modified)} />
      <JsonLd data={breadcrumbJsonLd(post)} />
      <a className="skip-link" href="#post-title">
        Skip to content
      </a>
      <SiteFrame page="blog">
        <main className="reading">
          <GraduatedAutonomyArticle post={post} />
        </main>
      </SiteFrame>
    </>
  );
}
