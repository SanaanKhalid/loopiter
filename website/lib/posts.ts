export type Post = {
  slug: string;
  title: string;
  description: string;
  /** First publication day, YYYY-MM-DD in UTC. */
  date: string;
  /** Last meaningful content change, YYYY-MM-DD in UTC. */
  dateModified: string;
};

export const posts: readonly Post[] = [
  {
    slug: 'evaluate-self-improving-ai-agents-offline',
    title: 'Evaluate self-improving AI agents offline before they change production',
    description:
      'How to evaluate a self-improving AI agent offline before production, using Loopiter’s mocked KB-QA benchmark: splits, gates, intervals, and spend caps. Zero live model calls.',
    date: '2026-11-10',
    dateModified: '2026-11-10',
  },
  {
    slug: 'self-improving-ai-agents-need-a-feedback-loop-you-can-evaluate',
    title: 'Self-improving AI agents need a feedback loop you can evaluate',
    description:
      'What self-improving agents change, why an outside evaluation matters, and which parts of that loop the Loopiter SDK actually runs.',
    date: '2026-11-06',
    dateModified: '2026-11-10',
  },
];

export function postPath(slug: string): string {
  return `/blog/${slug}`;
}

export function publishedLabel(date: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00.000Z`));
}

export function requirePost(slug: string): Post {
  const post = posts.find((item) => item.slug === slug);
  if (!post) throw new Error(`Missing blog post: ${slug}`);
  return post;
}
