import type { Metadata } from 'next';

export const siteUrl = 'https://loopiter.co';
export const siteName = 'Loopiter';
export const githubUrl = 'https://github.com/SanaanKhalid/loopiter';

/** Site-wide Open Graph card. Source SVG: website/public/og.svg. */
export const socialImage = {
  path: '/og.png',
  width: 1200,
  height: 630,
  alt: 'Loopiter wordmark on a dark code-console background. The card says governed improvement for AI systems. A console panel lists default mode recommend, autonomy as opt-in, and rollback to the previous version.',
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

export function socialImageMeta() {
  return {
    url: socialImage.path,
    width: socialImage.width,
    height: socialImage.height,
    alt: socialImage.alt,
  };
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
  const image = socialImageMeta();
  const shared = { title, description, url, siteName, locale: 'en_US' };
  const modifiedDay = modified ?? published;
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
          modifiedTime: `${modifiedDay}T00:00:00.000Z`,
          authors: [siteName],
          images: [image],
        }
      : { ...shared, type: 'website', images: [image] },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [image],
    },
  };
}
