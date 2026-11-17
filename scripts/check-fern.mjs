import { spawnSync } from 'node:child_process';
const env = { ...process.env };
// A caller may itself be running under `npm exec -c`; do not inherit its command.
delete env.npm_config_call;
delete env.npm_config_package;
const result = spawnSync(
  'npx',
  // CI validates repository content without a Fern account. Comparing redirects
  // with the deployed site remains part of authenticated publication validation.
  ['--yes', 'fern-api@5.113.1', 'check', '--warnings', '--local'],
  { env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
);
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
let diagnostics = `${result.stdout}${result.stderr}`;
// Fern 5.113.1 emits this deployment-only notice even with --local. CI has
// no Fern credentials; allow this exact notice while retaining every content,
// parsing, broken-link, network and authenticated redirect warning as a failure.
if (process.env.CI === 'true') {
  diagnostics = diagnostics.replace(
    "[warning] Missing redirects check skipped: not authenticated. Run 'fern login' or set the FERN_TOKEN environment variable to enable this check.",
    '[notice] Deployed redirect comparison requires authenticated release validation.',
  );
}
// Fern can classify MDX parse failures as warnings and still exit 0. Treat them as a gate.
if (result.error || result.status !== 0 || /\[warning\]|\[error\]|Markdown failed to parse/i.test(diagnostics))
  process.exitCode = 1;
