/** Files the published onboarding path reads from an installed package. */

export const packedSurface = {
  node: [
    'dist/src/onboarding.js',
    'dist/src/cli.js',
    'AGENT_GUIDE.md',
    'docs/application-observation.md',
    'dist/src/integrations/observe.js',
    'dist/src/integrations/otel.js',
  ],
  python: [
    'loopiter/onboarding.py',
    'loopiter/__main__.py',
    'loopiter/AGENT_GUIDE.md',
    'loopiter/docs/application-observation.md',
  ],
};

export function missingPacked(present, required) {
  const have = new Set(present);
  return required.filter(name => !have.has(name));
}

export function assertPacked(present, required, label) {
  const missing = missingPacked(present, required);
  if (missing.length > 0) {
    throw new Error(`${label} is missing from the packed artifact: ${missing.join(', ')}`);
  }
}
