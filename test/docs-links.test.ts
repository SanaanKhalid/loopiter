import assert from 'node:assert/strict';
import test from 'node:test';
import { DOCS, docsHref, legacyDocs } from '../website/lib/docs-links.js';

test('all known legacy docs anchors resolve to the canonical Fern host', () => {
  const anchors = [
    'overview',
    'installation',
    'analysis',
    'candidates',
    'self-improvement',
    'architecture',
    'execution-model',
    'signals',
    'evaluation',
    'deployment',
    'fine-tuning',
    'agent-systems',
    'storage',
    'security',
    'production',
    'api',
    'pitfalls',
    'faq',
  ];
  assert.deepEqual(Object.keys(legacyDocs).sort(), [...anchors].sort());
  for (const anchor of anchors) {
    const url = new URL(docsHref(`#${anchor}`));
    assert.equal(url.origin, DOCS);
    assert.equal(url.pathname, legacyDocs[anchor]);
  }
  for (const input of ['', '#unknown', '#__proto__', '#https://example.invalid', '#javascript:alert(1)'])
    assert.equal(docsHref(input), `${DOCS}/get-started/overview`);
});
