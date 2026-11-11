import { absoluteUrl } from './site';

function answer(sentences: readonly string[]): string {
  return sentences.join(' ');
}

export const faqs = [
  {
    question: 'What is Loopiter?',
    answer: answer([
      'Loopiter is an MIT-licensed SDK for a feedback loop in production AI systems.',
      'The Node.js and Python libraries in this repository capture executions and feedback, evaluate immutable candidates, and coordinate deployment or rollback through adapters the application owns.',
      'It is a library.',
      'A hosted console, REST API, and managed workers live in a separate repository and are not required to use these libraries.',
      'The core sends no telemetry and starts no daemon.',
    ]),
  },
  {
    question: 'How does the feedback loop work?',
    answer: answer([
      'The application records an execution and the prompt, model, and tool versions attached to it, then attaches verified feedback or outcomes to that execution.',
      'The SDK can report recurring scored segments and the evidence counts behind them.',
      'An improvement workflow proposes a bounded candidate, evaluates it against one frozen baseline, and can approve, deploy, observe, and roll back through adapters the application implements.',
      'The application calls tick.',
      'The core starts no scheduler and no daemon.',
    ]),
  },
  {
    question: 'What is the default autonomy level, and how do I change it?',
    answer: answer([
      'In this repository, a fresh self-hosted init in both Node.js and Python writes an integration plan at schemaVersion 2 with preset autonomous-default: mode autonomous and self-improving on.',
      'The plan starts incomplete, and initialization does not start a worker or spend.',
      'After doctor and verify, the worker recipe is --enable without --mode, so plan.mode controls the command.',
      'Omitting --mode follows plan.mode, and passing --mode overrides the plan.',
      'With no integration plan, the worker uses recommend.',
      'Constructing ImprovementController without a mode stays on recommend with self-improving off, and does not approve or deploy.',
      'The worker refuses to start without --enable.',
      '--enable authorizes improvement work and provider spending inside the existing gates, and it does not bypass audit, budgets, or rollback.',
      'The first autonomous run asks for a one-time confirmation: type activate on a terminal, or pass --confirm-activation or --yes when stdin is not a terminal.',
      'The worker stores that consent in .state/activation.json.',
      'The stamp is a consent record: it is not signed and it is not bound to a machine.',
      'A later run reuses it until the namespace or a hashed setting changes: schema version, mode, self-improving, namespace, plan step timeout, audit, policy, or budget.',
      'A one-off --step-timeout-ms flag is not part of that hash.',
      'Use --mode observe to inspect evidence without a proposal, --mode recommend to store proposals without applying them, and --mode experiment to compare and audit candidates without deployment.',
      'Existing schemaVersion 1 plans are left unchanged.',
      'An autonomous target is an exact prompt or routing key.',
      'On Node the policy may also name agent_release.',
      'Python accepts prompt and routing only.',
    ]),
  },
  {
    question: 'Which languages and runtime versions does Loopiter support?',
    answer: answer([
      'Loopiter is a TypeScript library for Node.js and a native async Python library.',
      'package.json engines allow Node.js 22 or 24, written as ^22.0.0 || ^24.0.0.',
      'pyproject.toml requires-python allows Python 3.11 or newer.',
      'The published npm package loopiter@0.3.0-alpha.1 advertises those same Node engines.',
      'The published PyPI package loopiter 0.3.0a1 requires Python 3.11 or newer.',
      'The Python library does not require Node.js.',
    ]),
  },
  {
    question: 'What are the runtime dependencies?',
    answer: answer([
      'In this repository, package.json declares no dependencies and an optional peer dependency on openai for the OpenAI wrapper.',
      'pyproject.toml sets dependencies to an empty list.',
      'Its optional extras are postgres, which installs psycopg, and openai.',
      'PostgreSQL stays optional: a Node application installs pg itself, and a Python application can install the postgres extra.',
      'The core has no required database driver, model client, scheduler, or telemetry.',
      'JsonFileStore, the Vercel AI SDK wrapper at loopiter/integrations/ai-sdk, and the OpenTelemetry exporter at loopiter/integrations/otel are Node-only.',
      'Python does not include them.',
    ]),
  },
  {
    question: 'How do I install Loopiter?',
    answer: answer([
      'Both packages are published.',
      'On npm, loopiter@0.3.0-alpha.1 is the alpha dist-tag and 0.2.0-alpha.1 is the latest dist-tag.',
      'Install the alpha with npm install loopiter@0.3.0-alpha.1.',
      'On PyPI, loopiter 0.3.0a1 is the current version.',
      'Install it with python -m pip install loopiter==0.3.0a1.',
      'The package pages are https://www.npmjs.com/package/loopiter and https://pypi.org/project/loopiter/.',
      'Those published archives are earlier alphas: the npm 0.3.0-alpha.1 tarball has no init or worker command, and the PyPI 0.3.0a1 sdist has no onboarding module.',
      'The self-hosted init and worker described on this site are in the repository at https://github.com/SanaanKhalid/loopiter.',
    ]),
  },
  {
    question: 'What license is Loopiter under?',
    answer: answer([
      'Loopiter is released under the MIT License.',
      'LICENSE at the repository root states Copyright (c) 2026 Loopiter contributors.',
      'package.json and pyproject.toml both set the license to MIT.',
      'The published npm package 0.3.0-alpha.1 reports license MIT, and the published PyPI release 0.3.0a1 reports license_expression MIT.',
    ]),
  },
] as const;

export function faqJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': `${absoluteUrl('/')}#faq`,
    url: `${absoluteUrl('/')}#faq`,
    mainEntity: faqs.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  };
}
