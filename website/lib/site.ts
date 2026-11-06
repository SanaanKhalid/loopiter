import type { Metadata } from 'next';

export const siteUrl = 'https://loopiter.co';
export const siteName = 'Loopiter';
export const githubUrl = 'https://github.com/SanaanKhalid/loopiter';

// The repository has no social-card image. website/public/favicon.svg is 24×24,
// and the Fern marks are small wordmarks. Summary cards use title and description.
type PageMetaInput = {
  title: string;
  description: string;
  path: string;
  index?: boolean;
  published?: string;
};

export function absoluteUrl(path: string): string {
  return new URL(path, siteUrl).href;
}

export function pageMetadata({
  title,
  description,
  path,
  index = true,
  published,
}: PageMetaInput): Metadata {
  const url = absoluteUrl(path);
  const shared = { title, description, url, siteName, locale: 'en_US' };
  return {
    title,
    description,
    alternates: { canonical: url },
    robots: { index, follow: true },
    openGraph: published
      ? {
          ...shared,
          type: 'article',
          publishedTime: `${published}T00:00:00.000Z`,
          modifiedTime: `${published}T00:00:00.000Z`,
          authors: [siteName],
        }
      : { ...shared, type: 'website' },
    twitter: { card: 'summary', title, description },
  };
}
