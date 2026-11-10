import Link from 'next/link';
import { PostBreadcrumb, PostByline } from './post-meta';
import { docUrl } from '../lib/docs-links';
import { postPath, type Post } from '../lib/posts';
import { githubUrl } from '../lib/site';

const benchmarkReadme = `${githubUrl}/blob/main/benchmarks/README.md`;
const feedbackPost = postPath('self-improving-ai-agents-need-a-feedback-loop-you-can-evaluate');

export function OfflineBenchmarkArticle({ post }: { post: Post }) {
  return (
    <article aria-labelledby="post-title">
      <header className="manifesto-heading">
        <PostBreadcrumb current={post.title} />
        <p className="eyebrow">Blog</p>
        <h1 id="post-title">{post.title}</h1>
        <p className="manifesto-deck">
          Before a self-improving loop is allowed to change a production artifact, compare a frozen baseline with the candidate on a held-out set the proposer never sees. Keep the change only when a validation gate, a later observation check, and a spend cap all agree. This note is that check, using Loopiter’s offline benchmark for autonomous agents: a synthetic knowledge-base task, seeded mocks, and zero live model calls.
        </p>
        <PostByline post={post} />
      </header>

      <div className="manifesto-body">
        <p>
          The figures below are the stdout of <code>npm run benchmark:offline</code> on 10 November 2026, with the default five seeds. <code>liveCalls</code> is 0 and <code>provider</code> is <code>mock</code>. Simulated dollars use a placeholder price table. They are not a provider invoice, and they are not a measurement of a real model.
        </p>

        <section aria-labelledby="two-arms">
          <h2 id="two-arms">Frozen baseline, autonomous candidate</h2>
          <p>
            The harness in <code>benchmarks/</code> compares two arms on one task. It is part of the repository and is not in the published npm package. The benchmark README says Python has the same controller and that this harness is Node-only. The harness imports the Node SDK only.
          </p>
          <p>
            The frozen baseline does not improve. It serves the starting knowledge-base fragment and scores that fragment on the held-out split.
          </p>
          <p>
            The other arm is the SDK <code>ImprovementController</code> with <code>mode</code> set to <code>autonomous</code> and <code>selfImproving: true</code>. The only artifact it may change is a short fragment of <code>id=value</code> passage lines. The policy target is a prompt, key <code>internal-kb</code>, and the change schema allows one string field, <code>fragment</code>, up to 800 characters. Retrieval is a frozen keyword lookup. It does not read the fragment, so an edit cannot change which passage comes back. After validation, audit, and observation, the harness scores whatever fragment is still being served. A rejected change leaves the baseline in place.
          </p>
          <p>
            The proposer and the answerer are functions in the harness. The command refuses <code>--live</code> and the environment variable <code>LOOPITER_BENCHMARK_LIVE=1</code>. The string <code>gpt-5.4-mini</code> is the key in the placeholder price table, not a model that was contacted. The table prices that label at $1 per million input tokens and $4 per million output tokens. A proposal is 120 input tokens and 40 output tokens, with 40 ms of simulated latency. An answer is 80 and 12 tokens, with 15 ms. Costs are integer micro-USD. Replaying the same seed replays the same bill.
          </p>
        </section>

        <section aria-labelledby="splits">
          <h2 id="splits">Train, dev, and a held-out test</h2>
          <p>
            One block has fourteen question templates: eight single-fact questions, two questions that need two passages, two retrieval misses, and two questions that are out of scope.
          </p>
          <p>
            Train is one block, fourteen rows. Those rows are the controller’s optimization partition. The proposer sees them and writes the train label into each passage a hit actually names. It leaves misses and out-of-scope rows alone.
          </p>
          <p>
            Dev is two partitions. Validation is four blocks, fifty-six rows. Audit is sixteen blocks, two hundred twenty-four rows. Audit is a pre-deploy gate, not the final score. The objective is to maximize accuracy, with a minimum improvement of 0.05, on a score from 0 to 1. On the validation split the observed improvement has to be greater than 0.05, and the guardrails still apply. This policy does not supply a custom audit method, so on the audit split the controller uses a fixed-sample paired Hoeffding lower bound and requires that bound to be greater than 0.05. The recorded assumption is independent units. Guardrails require accuracy at or above 0.15 and latency at or below 100 ms. The latency in this harness is the mock’s 15 ms, not a measured network time.
          </p>
          <p>
            The held-out test is four blocks, fifty-six rows. It is scored only after the loop finishes. It is not passed to <code>dataset</code>, <code>propose</code>, or <code>evaluate</code>, and the harness throws if a test id appears in those callbacks. Observation uses a different slice of fifty-six rows. That slice is not the test split either.
          </p>
          <p>
            Four of the fourteen templates cannot be fixed by editing the fragment. The misses ask about a per diem and an access token. The out-of-scope questions ask for a home address and a share price. Retrieval does not return a passage whose text is the labeled answer, and the mock returns the text of whatever passage it did retrieve. The other ten templates are in scope. A hit returns the named passage plus a distractor, such as staff vacation beside contractor vacation.
          </p>
          <p>
            The frozen fragment is already right for three passages: staff vacation is 18 days, the travel allowance is 250 usd, and a visitor badge is collected at the reception desk. The other five are stale. On that fragment, a non-slipping answer can be correct only for those three single-fact questions. Both multi-hop questions need a stale passage, so they are wrong at the baseline. That ceiling comes from the task definition. It was not fitted to the score.
          </p>
        </section>

        <section aria-labelledby="slips">
          <h2 id="slips">The same seed slips the same way</h2>
          <p>
            The mock answerer is imperfect on purpose. Each seed draws a reliability between 0.68 and 0.86. The band is <code>0.68 + draw × 0.18</code> from a seeded generator in the task file. It is not tuned to a held-out number.
          </p>
          <p>
            Whether one question slips depends on the seed and the question text. The same pair always takes the same branch. A different seed does not. On a slip, a multi-hop question returns only the first fact. Any other hit returns either the distractor passage or the token <code>incomplete</code>. Misses and out-of-scope questions ignore the labeled facts.
          </p>
          <p>
            Unfixable rows and those slips keep held-out success below the ceiling. The rates are whatever that mixture produces. The token bill does not move with them.
          </p>
        </section>

        <section aria-labelledby="intervals">
          <h2 id="intervals">Seed bootstrap, then a Wilson interval</h2>
          <p>
            The primary 95% interval is a percentile bootstrap of the mean held-out success rate. The unit is the seed, because the seed is the repeated run. The default resamples the five seed rates with replacement, 2000 times, with bootstrap seed 17. Endpoints use linear interpolation between order statistics, the same index rule as NumPy’s default percentile. The interval has width because the five rates differ. It collapses to a point only when every seed rate is identical. Five seeds describe this harness. They are not a sample of production traffic.
          </p>
          <p>
            The report also prints a Wilson score interval on the pooled held-out trials, using z = 1.959963984540054. Pooling treats each trial as an i.i.d. Bernoulli draw. On this balanced synthetic set that is a convenience view. Every seed has 56 held-out trials, so the mean of the seed rates equals the pooled rate. The two intervals still answer different questions, and neither is a traffic estimate.
          </p>
        </section>

        <section aria-labelledby="numbers">
          <h2 id="numbers">What the mocked run printed</h2>
          <p className="benchmark-note">
            Mocked results only. The table is the Markdown summary printed by <code>npm run benchmark:offline</code> on 10 November 2026. Live model calls: 0. Provider: mock. Costs are simulated tokens times the placeholder price table. This is not a claim about real-world model performance.
          </p>
          <div className="table-scroll">
            <table className="benchmark-table">
              <caption>Held-out success on the synthetic KB-QA task, five seeds, mocked answers.</caption>
              <thead>
                <tr>
                  <th scope="col">Arm</th>
                  <th scope="col" className="num">Held-out success</th>
                  <th scope="col">95% seed bootstrap</th>
                  <th scope="col">Wilson pooled</th>
                  <th scope="col" className="num">Simulated cost</th>
                  <th scope="col" className="num">Simulated latency</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Frozen baseline</th>
                  <td className="num">0.1464</td>
                  <td>[0.1179, 0.1679]</td>
                  <td>[0.1098, 0.1926]</td>
                  <td className="num">$0.035840</td>
                  <td className="num">4200 ms</td>
                </tr>
                <tr>
                  <th scope="row">Autonomous candidate</th>
                  <td className="num">0.5429</td>
                  <td>[0.4786, 0.5929]</td>
                  <td>[0.4843, 0.6002]</td>
                  <td className="num">$0.431480</td>
                  <td className="num">50600 ms</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            The baseline mean is 41 correct answers out of 280 held-out trials. The candidate mean is 152 out of 280. Rates in the table are those means rounded to four decimals, which is how the command prints them.
          </p>
          <div className="table-scroll">
            <table className="benchmark-table">
              <caption>Per-seed held-out rates. Each candidate finished in completed.</caption>
              <thead>
                <tr>
                  <th scope="col" className="num">Seed</th>
                  <th scope="col" className="num">Baseline</th>
                  <th scope="col" className="num">Candidate</th>
                  <th scope="col" className="num">Candidate cost</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="num">1</td>
                  <td className="num">0.1429</td>
                  <td className="num">0.5357</td>
                  <td className="num">$0.086296</td>
                </tr>
                <tr>
                  <td className="num">2</td>
                  <td className="num">0.1786</td>
                  <td className="num">0.5536</td>
                  <td className="num">$0.086296</td>
                </tr>
                <tr>
                  <td className="num">3</td>
                  <td className="num">0.1607</td>
                  <td className="num">0.6250</td>
                  <td className="num">$0.086296</td>
                </tr>
                <tr>
                  <td className="num">4</td>
                  <td className="num">0.0893</td>
                  <td className="num">0.4286</td>
                  <td className="num">$0.086296</td>
                </tr>
                <tr>
                  <td className="num">5</td>
                  <td className="num">0.1607</td>
                  <td className="num">0.5714</td>
                  <td className="num">$0.086296</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            Each candidate seed ended in <code>completed</code> with reason <code>offline_pass_and_production_limits_met_not_causal_proof</code>. The controller uses that string for an immediate rollout that cleared the offline gate and the production limits. The wording is the caveat. Passing this run is not causal proof that the change is better in the world.
          </p>
          <p>
            The candidate bill is larger because the gates score more rows, not because a provider priced a long completion. One seed’s loop is 617 mocked calls: 1 proposal, 112 validation answers, 448 audit answers, and 56 observation answers. Validation and audit score the current fragment and the candidate on each row, which is why those counts are twice the partition size. Held-out scoring adds 56 calls and $0.007168. The loop itself is $0.079128. Together that is the $0.086296 in the table. Five seeds make the arm totals above: 280 baseline calls and 3365 candidate calls. The comparison spent $0.467320 against a $5.000000 cap, and the report marks the cap as adhered to.
          </p>
          <p>
            The process exits 0 only when the comparison stayed inside its caps, both checks below passed, every autonomous seed finished in <code>completed</code>, and the candidate’s mean held-out rate is above the frozen baseline. This synthetic task is expected to improve. A loss on a later task is reported the same way and fails the process until that expectation is changed on purpose. This run’s <code>passed</code> field was true.
          </p>
        </section>

        <section aria-labelledby="harmful">
          <h2 id="harmful">A harmful candidate has to be rejected</h2>
          <p>
            The regression check injects a fragment that sets every passage, including the three the baseline had right, to the literal value <code>redacted</code>. It uses seed 1, the first default seed.
          </p>
          <p>
            The validation gate rejected it. The final state was <code>no_improvement</code> and the reason was <code>validation_failed</code>. The served artifact stayed on the baseline version. Served held-out success stayed 0.1429, the same as that seed’s frozen baseline. Tolerance is 0, so any drop fails the check.
          </p>
          <p>
            The report also scores that harmful fragment off to the side, as if it had been served. The counterfactual held-out rate was 0.0000, worse than the baseline, so the injection was actually harmful. The gate decided on the validation partition, not on this held-out number. The counterfactual is there so a rejected candidate cannot be a harmless no-op that only looks like a safety win.
          </p>
        </section>

        <section aria-labelledby="rollback">
          <h2 id="rollback">Failed observation restores the previous version</h2>
          <p>
            A second case proposes an improvement the offline gates can accept, then forces production observation to fail. The harness marks every production row wrong, so the error rate is 1. The policy requires <code>errors</code> at or below 0.85. <code>onFailure</code> and <code>onTimeout</code> are both <code>rollback</code>. While the state is <code>observing</code>, the harness moves its clock forward by two hours so the one-hour minimum observation window has elapsed.
          </p>
          <p>
            The run ended in <code>rolled_back</code> with reason <code>previous_version_restored</code>, after a <code>production_guardrail_failed</code> transition. The served version matched the baseline version. Served held-out success stayed 0.1429. Rollback restores the recorded predecessor, not whichever version is newest. The apply and rollback adapter in this harness is an in-memory stand-in. In an application, that adapter is yours.
          </p>
        </section>

        <section aria-labelledby="spend">
          <h2 id="spend">Spend caps stop the next call</h2>
          <p>
            The five-seed comparison uses wide simulated caps: $1 for one arm of one seed, and $5 for the whole comparison. The budget check is a separate pair of runs with caps taken from the mock price of a few calls. The per-run cap is one proposal plus two answers, $0.000536. The total cap is that amount plus one more proposal and one more answer, $0.000944.
          </p>
          <p>
            Seed 11 stopped on <code>per_run_cap</code>. The state was <code>failed</code>, the reason was <code>spend_cap</code>, the charged spend was $0.000536, and the run made 3 charged calls and refused 1. Seed 12 stopped on <code>total_cap</code>, with $0.000408 charged, 2 calls, and 1 refusal. Neither run finished as <code>completed</code>. Charged spend for the pair was $0.000944, equal to the total cap.
          </p>
          <p>
            The ledger refuses a call that would exceed either cap, and it checks the per-run cap first. The mock throws <code>spend_cap</code> before that call is added, so a refused call is not a charge. The controller policy for this task also sets daily ceilings for model requests, tokens, and deployments, with one deployment and no unlimited fallback. Those ceilings are separate from the USD ledger. The policy also caps this task at one proposal and one candidate.
          </p>
        </section>

        <section aria-labelledby="run">
          <h2 id="run">How to run it</h2>
          <p>
            From the repository root, with Node.js 22 or 24:
          </p>
          <pre className="command-block"><code>{`npm ci
npm run benchmark:offline`}</code></pre>
          <p>
            That builds the SDK and runs seeds 1 through 5. The process exits non-zero if the regression check or the budget check fails. The JSON on stdout is the source of truth. To write a report:
          </p>
          <pre className="command-block"><code>{`npm run build
node dist/benchmarks/kb-qa/run.js --seeds 5 --out reports/offline-kb-qa.json`}</code></pre>
          <p>
            A Markdown summary is written beside the JSON. Defaults you can override: <code>--seeds 5</code>, <code>--per-run-usd 1</code>, <code>--total-usd 5</code>, <code>--tolerance 0</code>, <code>--bootstrap 2000</code>, <code>--bootstrap-seed 17</code>. Do not set a provider key for this command. <code>--live</code> exits with an error and does not call a model.
          </p>
          <p>
            Unit tests for the intervals, the ledger, and the check rules run under <code>npm test</code>. CI runs the five-seed harness in the <code>offline-benchmark</code> job. The protocol is written up in the <a className="inline-link" href={benchmarkReadme}>benchmark README</a>.
          </p>
        </section>

        <section aria-labelledby="not-this">
          <h2 id="not-this">What this AI agent evaluation is not</h2>
          <p>
            This is an offline benchmark you can rerun. It is not evidence that a production agent improved. The answers are seeded functions. The knowledge base is fourteen lines of invented handbook facts. The Wilson interval is not a traffic estimate. The bootstrap describes five seeds. The completed reason says the pass is not causal proof.
          </p>
          <p>
            A later live run is not implemented, and the README says it must not be started from this harness. It would need a separate change, explicit approval, and spend caps, and those results would stay internal. The Phase 0 command spends no money.
          </p>
          <p>
            The SDK rules around the harness — immutable candidates, the audit split, receipts, and rollback — are in the <a className="inline-link" href={docUrl('evaluation')}>evaluation and deployment guide</a> and in the note on <Link className="inline-link" href={feedbackPost}>why the loop has to be evaluable</Link>. The <Link className="inline-link" href="/manifesto">manifesto</Link> states the product intent. The <Link className="inline-link" href="/">landing page</Link> is the SDK introduction. This benchmark is the offline check in front of that intent, and only for the mocked task above.
          </p>
        </section>
      </div>

      <div className="manifesto-next">
        <Link className="text-link" href={feedbackPost}>Why the loop has to be evaluable <span aria-hidden="true">↗</span></Link>
        <Link className="text-link" href="/manifesto">Read the manifesto <span aria-hidden="true">↗</span></Link>
        <a className="text-link" href={docUrl('evaluation')}>Evaluation and deployment <span aria-hidden="true">↗</span></a>
      </div>
    </article>
  );
}
