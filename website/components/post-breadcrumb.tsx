import Link from 'next/link';

export function PostBreadcrumb({ title }: { title: string }) {
  return (
    <nav className="post-crumb" aria-label="Breadcrumb">
      <ol>
        <li>
          <Link href="/">Home</Link>
        </li>
        <li>
          <Link href="/blog">Blog</Link>
        </li>
        <li aria-current="page">{title}</li>
      </ol>
    </nav>
  );
}
