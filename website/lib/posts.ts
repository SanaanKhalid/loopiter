export type Post = {
  slug: string;
  title: string;
  description: string;
  date: string;
};

export const posts: readonly Post[] = [
  {
    slug: 'graduated-autonomy-for-self-improving-ai-agents',
    title:
      'Graduated autonomy for self-improving AI agents: observe, recommend, experiment, autonomous',
    description:
      'How the observe, recommend, experiment, and autonomous modes differ in the Loopiter SDKs, why a fresh init records autonomous mode, and what still gates deployment and rollback.',
    date: '2026-11-11',
  },
  {
    slug: 'self-improving-ai-agents-need-a-feedback-loop-you-can-evaluate',
    title: 'Self-improving AI agents need a feedback loop you can evaluate',
    description:
      'What self-improving agents change, why an outside evaluation matters, and which parts of that loop the Loopiter SDK actually runs.',
    date: '2026-11-06',
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
