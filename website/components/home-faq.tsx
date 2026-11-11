import Link from 'next/link';
import { faqs, faqJsonLd } from '../lib/faq';
import { docUrl } from '../lib/docs-links';
import { JsonLd } from './json-ld';

export function HomeFaq() {
  return (
    <section className="section" id="faq" aria-labelledby="faq-title">
      <JsonLd data={faqJsonLd()} />
      <div className="section-heading compact">
        <div className="section-label">[ FAQ ]</div>
        <h2 id="faq-title">Questions about the SDK.</h2>
        <p>
          Plain answers from the SDK source, the package manifests, and the public npm and PyPI registries.
        </p>
      </div>
      <div className="faq-list">
        {faqs.map((item) => (
          <details key={item.question} open>
            <summary>{item.question}</summary>
            <p>{item.answer}</p>
          </details>
        ))}
      </div>
      <div className="manifesto-next">
        <Link className="text-link" href="/blog/self-improving-ai-agents-need-a-feedback-loop-you-can-evaluate">
          Why a feedback loop has to be evaluable <span aria-hidden="true">→</span>
        </Link>
        <Link className="text-link" href="/blog/graduated-autonomy-for-self-improving-ai-agents">
          Graduated autonomy, mode by mode <span aria-hidden="true">→</span>
        </Link>
        <a className="text-link" href={docUrl('autonomous')}>
          Autonomy modes in the documentation <span aria-hidden="true">→</span>
        </a>
      </div>
    </section>
  );
}
