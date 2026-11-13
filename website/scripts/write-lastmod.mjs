import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const websiteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(websiteRoot, '..');

const articleSources = {
  'self-improving-ai-agents-need-a-feedback-loop-you-can-evaluate': [
    'website/components/feedback-loop-article.tsx',
  ],
  'graduated-autonomy-for-self-improving-ai-agents': [
    'website/components/graduated-autonomy-article.tsx',
  ],
};

function readSlugs() {
  const text = readFileSync(resolve(websiteRoot, 'lib/posts.ts'), 'utf8');
  return [...text.matchAll(/slug:\s*'([^']+)'/g)].map((match) => match[1]);
}

function lastModified(paths) {
  for (const rel of paths) statSync(resolve(repoRoot, rel));
  if (!existsSync(resolve(repoRoot, '.git'))) {
    throw new Error(
      `Cannot date ${paths.join(', ')}: this build is not a git checkout.`,
    );
  }
  let git = '';
  try {
    git = execFileSync(
      'git',
      ['log', '-1', '--format=%cI', '--', ...paths],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git log failed for ${paths.join(', ')}: ${message}`);
  }
  // A shallow checkout often has no history for paths the tip commit did not
  // touch. Filesystem mtime is then the checkout time, not the content commit.
  if (!git || Number.isNaN(Date.parse(git))) {
    throw new Error(
      `git log returned no commit for ${paths.join(', ')}. Fetch full history before building (actions/checkout fetch-depth: 0). Refusing to use filesystem mtime.`,
    );
  }
  return git;
}

const slugs = readSlugs();
for (const slug of slugs) {
  if (!Object.hasOwn(articleSources, slug)) {
    throw new Error(`Add article source files for blog slug ${slug}`);
  }
}

const routes = {
  '/': [
    'website/app/page.tsx',
    'website/lib/faq.ts',
    'website/components/home-faq.tsx',
  ],
  '/manifesto': ['website/app/manifesto/page.tsx'],
  '/blog': ['website/app/blog/page.tsx', 'website/lib/posts.ts'],
};

for (const slug of slugs) {
  routes[`/blog/${slug}`] = [
    `website/app/blog/${slug}/page.tsx`,
    'website/lib/posts.ts',
    ...articleSources[slug],
  ];
}

const dates = {};
for (const [route, paths] of Object.entries(routes)) {
  dates[route] = lastModified(paths);
}

const body = `// Generated at build time by scripts/write-lastmod.mjs. Do not edit.
export const lastModifiedByRoute: Readonly<Record<string, string>> = ${JSON.stringify(dates, null, 2)};
`;

writeFileSync(resolve(websiteRoot, 'lib/last-modified.generated.ts'), body);
