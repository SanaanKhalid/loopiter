import type { MetadataRoute } from 'next';
import { routeLastModified } from '../lib/last-modified';
import { postPath, posts } from '../lib/posts';
import { absoluteUrl, siteUrl } from '../lib/site';

function modified(route: string, fallbackDate?: string): Date {
  return new Date(routeLastModified(route, fallbackDate));
}

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: siteUrl,
      lastModified: modified('/'),
      changeFrequency: 'monthly',
      priority: 1,
    },
    {
      url: absoluteUrl('/manifesto'),
      lastModified: modified('/manifesto'),
      changeFrequency: 'yearly',
      priority: 0.6,
    },
    {
      url: absoluteUrl('/blog'),
      lastModified: modified('/blog'),
      changeFrequency: 'monthly',
      priority: 0.8,
    },
    ...posts.map((post) => ({
      url: absoluteUrl(postPath(post.slug)),
      lastModified: modified(postPath(post.slug), post.date),
      changeFrequency: 'yearly' as const,
      priority: 0.7,
    })),
  ];
}
