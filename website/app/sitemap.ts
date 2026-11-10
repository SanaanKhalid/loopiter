import type { MetadataRoute } from 'next';
import { postPath, posts } from '../lib/posts';
import { absoluteUrl, siteUrl } from '../lib/site';

const pageUpdated = new Date('2026-11-10T00:00:00.000Z');

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: siteUrl, lastModified: pageUpdated, changeFrequency: 'monthly', priority: 1 },
    { url: absoluteUrl('/manifesto'), lastModified: pageUpdated, changeFrequency: 'yearly', priority: 0.6 },
    { url: absoluteUrl('/blog'), lastModified: pageUpdated, changeFrequency: 'monthly', priority: 0.8 },
    ...posts.map((post) => ({
      url: absoluteUrl(postPath(post.slug)),
      lastModified: new Date(`${post.dateModified}T00:00:00.000Z`),
      changeFrequency: 'yearly' as const,
      priority: 0.7,
    })),
  ];
}
