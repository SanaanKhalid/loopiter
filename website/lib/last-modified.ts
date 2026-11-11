import { lastModifiedByRoute } from './last-modified.generated';

export function routeLastModified(route: string, fallbackDate?: string): string {
  const found = lastModifiedByRoute[route];
  if (found) return found;
  if (fallbackDate) {
    return fallbackDate.includes('T')
      ? fallbackDate
      : `${fallbackDate}T00:00:00.000Z`;
  }
  throw new Error(
    `No last-modified date for ${route}. Run node scripts/write-lastmod.mjs.`,
  );
}
