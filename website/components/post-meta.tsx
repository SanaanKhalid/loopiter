import Link from 'next/link';
import { publishedLabel, type Post } from '../lib/posts';

export function PostBreadcrumb({ current }: { current: string }) {
  return (
    <nav className="post-crumbs" aria-label="Breadcrumb">
      <Link href="/">Home</Link>
      <span aria-hidden="true">/</span>
      <Link href="/blog">Blog</Link>
      <span aria-hidden="true">/</span>
      <span aria-current="page">{current}</span>
    </nav>
  );
}

export function PostByline({ post }: { post: Post }) {
  return (
    <p className="post-byline">
      <time dateTime={post.date}>{publishedLabel(post.date)}</time>
      {post.dateModified !== post.date ? (
        <time dateTime={post.dateModified}>Updated {publishedLabel(post.dateModified)}</time>
      ) : null}
      <span>Loopiter</span>
    </p>
  );
}
