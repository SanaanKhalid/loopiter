import type { Metadata } from 'next';

export const siteUrl = 'https://loopiter.co';
export const siteName = 'Loopiter';
export const githubUrl = 'https://github.com/SanaanKhalid/loopiter';
export const npmPackageUrl = 'https://www.npmjs.com/package/loopiter';
export const pypiPackageUrl = 'https://pypi.org/project/loopiter/';

export const socialImage = {
  url: '/og.png',
  width: 1200,
  height: 630,
  alt: 'Loopiter, a dark code console for a feedback loop. The modes are observe, recommend, experiment, and autonomous. A fresh init records autonomous mode.',
  type: 'image/png',
} as const;

type PageMetaInput = {
  title: string;
  description: string;
  path: string;
  index?: boolean;
  published?: string;
  modified?: string;
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
  modified,
}: PageMetaInput): Metadata {
  const url = absoluteUrl(path);
  const shared = { title, description, url, siteName, locale: 'en_US' };
  const twitter = {
    card: 'summary_large_image' as const,
    title,
    description,
    images: [socialImage],
  };
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
          modifiedTime: modified ?? `${published}T00:00:00.000Z`,
          authors: [siteName],
          images: [socialImage],
        }
      : { ...shared, type: 'website', images: [socialImage] },
    twitter,
  };
}
