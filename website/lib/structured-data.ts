import { postPath, type Post } from './posts';
import { absoluteUrl, githubUrl, siteName, siteUrl } from './site';

const organizationId = `${siteUrl}/#organization`;
const websiteId = `${siteUrl}/#website`;
const softwareId = `${siteUrl}/#software`;

const softwareDescription =
  'A lightweight, model-agnostic feedback loop for production AI systems. MIT-licensed TypeScript and Python libraries that capture executions and feedback, evaluate immutable candidates, and coordinate deployment or rollback through application-owned adapters.';

export const siteGraph = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': organizationId,
      name: siteName,
      url: siteUrl,
      description:
        'Loopiter maintains an MIT-licensed SDK for feedback-driven improvement of production AI systems. The hosted platform is in development.',
      sameAs: [githubUrl],
    },
    {
      '@type': 'WebSite',
      '@id': websiteId,
      name: siteName,
      url: siteUrl,
      description:
        'Landing page, manifesto, and notes for Loopiter, a feedback loop for AI agents.',
      publisher: { '@id': organizationId },
      inLanguage: 'en',
    },
    {
      '@type': ['SoftwareSourceCode', 'SoftwareApplication'],
      '@id': softwareId,
      name: siteName,
      url: siteUrl,
      description: softwareDescription,
      applicationCategory: 'DeveloperApplication',
      applicationSubCategory: 'Software library',
      operatingSystem: 'Node.js 22 or 24; Python 3.11 or newer',
      softwareVersion: '0.3.0-alpha.1',
      softwareRequirements: 'Node.js 22 or 24, or Python 3.11+',
      programmingLanguage: ['TypeScript', 'Python'],
      runtimePlatform: ['Node.js', 'Python'],
      codeRepository: githubUrl,
      license: 'https://opensource.org/licenses/MIT',
      isAccessibleForFree: true,
      author: { '@id': organizationId },
      publisher: { '@id': organizationId },
    },
  ],
};

export function blogJsonLd(items: readonly Post[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    '@id': `${absoluteUrl('/blog')}#blog`,
    name: 'Loopiter blog',
    description:
      'Notes on evaluation and feedback loops for AI agents, and how the Loopiter SDK implements them.',
    url: absoluteUrl('/blog'),
    inLanguage: 'en',
    publisher: { '@id': organizationId },
    blogPost: items.map((post) => ({
      '@type': 'BlogPosting',
      headline: post.title,
      description: post.description,
      datePublished: post.date,
      url: absoluteUrl(postPath(post.slug)),
    })),
  };
}

export function articleJsonLd(post: Post) {
  const url = absoluteUrl(postPath(post.slug));
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    '@id': `${url}#article`,
    headline: post.title,
    description: post.description,
    datePublished: post.date,
    dateModified: post.date,
    inLanguage: 'en',
    mainEntityOfPage: url,
    url,
    author: { '@type': 'Organization', name: siteName, url: siteUrl },
    publisher: { '@type': 'Organization', name: siteName, url: siteUrl },
    isPartOf: {
      '@type': 'Blog',
      name: 'Loopiter blog',
      url: absoluteUrl('/blog'),
    },
  };
}
