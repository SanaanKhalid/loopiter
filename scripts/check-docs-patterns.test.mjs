import assert from 'node:assert/strict';
import test from 'node:test';
import { controllerCalls, omittedModeClaimsRecommend } from './check-docs.mjs';

const staleArticle =
  'Recommend stores bounded proposals. It does not approve them and it does not deploy them. This is the mode you get from constructing ImprovementController without a mode, in Node and in Python. Self-improving stays off unless you pass the flag.';

test('the old recommend-by-omission sentence fails the checker', () => {
  assert.ok(omittedModeClaimsRecommend(staleArticle).length > 0);
});

test('other omission phrasings near recommend fail the checker', () => {
  for (const line of [
    'Omitting mode selects recommend.',
    'Omit the mode and you get recommend.',
    'With no mode the controller defaults to recommend.',
    "If you don't pass mode, you stay on recommend.",
    'Do not pass mode if you want recommend.',
    'If mode is omitted, the controller recommends.',
    'Leave mode unset and the controller stays on recommend.',
    'The default controller mode is recommend.',
    'Requires Node 22.1.0 or later; omitting mode selects recommend.',
    'Leave the mode unset to get recommend.',
    'Leave `mode` unset to get recommend.',
    'Leaving mode unset selects recommend.',
    'With mode omitted, the controller recommends.',
    'When mode is not set, the controller recommends.',
    'Unlike 0.3.0-alpha.1, omitting the mode selects recommend.',
    'The default mode is recommend.',
    'The controller mode defaults to recommend.',
  ])
    assert.ok(omittedModeClaimsRecommend(line).length > 0, line);
});

test('a later version in a JS string array does not exempt an earlier claim', () => {
  const source = `
    answer([
      'With no integration plan, the worker uses autonomous.',
      'Omitting mode selects recommend.',
      'These defaults are unreleased, on main, and are not in the published 0.3.0-alpha.1 or 0.3.0a1 packages.',
    ])
  `;
  assert.ok(omittedModeClaimsRecommend(source).length > 0);
});

test('autonomous before recommend is not a recommend-by-omission claim', () => {
  assert.deepEqual(omittedModeClaimsRecommend('Leave mode unset for autonomous; set it to recommend to opt out.'), []);
});

test('a published sentence in another paragraph does not exempt a stale claim', () => {
  const text = [
    'The published notes describe an older archive.',
    '',
    'If mode is omitted, the controller recommends.',
  ].join('\n');
  assert.ok(omittedModeClaimsRecommend(text).length > 0);
});

test('published alpha notes that mention recommend still pass', () => {
  assert.deepEqual(
    omittedModeClaimsRecommend(
      'Constructing the controller without a mode is autonomous on main. The published v0.3.0-alpha.1 still defaults to recommend.',
    ),
    [],
  );
  assert.deepEqual(omittedModeClaimsRecommend('With no mode the published 0.3.0a1 package stays on recommend.'), []);
});

test('the real default and optional mode signatures are not flagged', () => {
  assert.deepEqual(
    omittedModeClaimsRecommend(
      'Constructing ImprovementController with no mode is autonomous, with self-improving on.',
    ),
    [],
  );
  const signatures = [
    'SelfImprovementController(loop)',
    'ImprovementController(loop, {workflows, mode?, selfImproving?})',
    'new ImprovementController(loop, { mode: "recommend", workflows: [workflow] })',
  ].join('\n');
  const unmoded = controllerCalls(signatures).filter(call => !/\bmode\??\s*[:=,}]/.test(call.source));
  assert.deepEqual(unmoded, []);
});
