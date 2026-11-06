import type { MetadataRoute } from 'next';
import { postPath, posts } from '../lib/posts';
import { absoluteUrl, siteUrl } from '../lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  const published = new Date('2026-11-06T00:00:00.000Z');
  return [
    { url: siteUrl, lastModified: published, changeFrequency: 'monthly', priority: 1 },
    { url: absoluteUrl('/manifesto'), lastModified: published, changeFrequency: 'yearly', priority: 0.6 },
    { url: absoluteUrl('/blog'), lastModified: published, changeFrequency: 'monthly', priority: 0.8 },
    ...posts.map((post) => ({
      url: absoluteUrl(postPath(post.slug)),
      lastModified: new Date(`${post.date}T00:00:00.000Z`),
      changeFrequency: 'yearly' as const,
      priority: 0.7,
    })),
  ];
}
