// Live robots.txt at https://loopiter.co is served by Cloudflare's managed
// robots.txt setting, which overrides this file. Edits here may not take
// effect live; changes to crawler rules must be made in Cloudflare.
import type { MetadataRoute } from 'next';
import { absoluteUrl } from '../lib/site';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/' },
    sitemap: absoluteUrl('/sitemap.xml'),
    host: 'https://loopiter.co',
  };
}
