import type { Metadata } from 'next';
import { FeedbackLoopArticle } from '../../../components/feedback-loop-article';
import { JsonLd } from '../../../components/json-ld';
import { SiteFooter, SiteHeader } from '../../../components/site-chrome';
import { postPath, requirePost } from '../../../lib/posts';
import { pageMetadata } from '../../../lib/site';
import { articleJsonLd } from '../../../lib/structured-data';

const post = requirePost('self-improving-ai-agents-need-a-feedback-loop-you-can-evaluate');

export const metadata: Metadata = pageMetadata({
  title: `${post.title} — Loopiter`,
  description: post.description,
  path: postPath(post.slug),
  published: post.date,
});

export default function FeedbackLoopPost() {
  return (
    <>
      <JsonLd data={articleJsonLd(post)} />
      <a className="skip-link" href="#post-title">Skip to content</a>
      <SiteHeader page="blog" />
      <main className="manifesto-page">
        <FeedbackLoopArticle post={post} />
      </main>
      <SiteFooter />
    </>
  );
}
