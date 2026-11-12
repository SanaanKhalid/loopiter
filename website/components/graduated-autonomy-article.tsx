import Link from 'next/link';
import { docUrl } from '../lib/docs-links';
import { publishedLabel, type Post } from '../lib/posts';
import { PostBreadcrumb } from './post-breadcrumb';

const nodeExample = `import {
  FeedbackLoop,
  ImprovementController,
  type ImprovementWorkflow,
} from "loopiter";

// The application supplies the workflow, including policy and adapters.
export function attachAutonomy(loop: FeedbackLoop, workflow: ImprovementWorkflow) {
  return new ImprovementController(loop, {
    selfImproving: true,
    mode: "autonomous",
    workflows: [workflow],
  });
}

// Omit mode and selfImproving: recommend, and self-improving stays off.
export function attachRecommend(loop: FeedbackLoop, workflow: ImprovementWorkflow) {
  return new ImprovementController(loop, { workflows: [workflow] });
}

export function scheduledTick(controller: ImprovementController, workflowId: string) {
  return controller.tick(workflowId);
}`;

const pythonExample = `from loopiter import FeedbackLoop, ImprovementController, ImprovementWorkflow

def attach_autonomy(loop: FeedbackLoop, workflow: ImprovementWorkflow):
    return ImprovementController(
        loop, workflows=[workflow], self_improving=True, mode="autonomous"
    )

def attach_recommend(loop: FeedbackLoop, workflow: ImprovementWorkflow):
    # Omit mode and self_improving: recommend, and self-improving stays off.
    return ImprovementController(loop, workflows=[workflow])

async def scheduled_tick(controller: ImprovementController, workflow_id: str):
    return await controller.tick(workflow_id)`;

const workerExample = `# Node. Omitting --mode follows plan.mode.
npx --no-install loopiter worker --module ./loopiter/application.mjs --enable --once

# Python.
python -m loopiter worker --module loopiter/application.py --enable --once

# Store proposals and do not apply them.
npx --no-install loopiter worker --module ./loopiter/application.mjs --enable --mode recommend --once
python -m loopiter worker --module loopiter/application.py --enable --mode recommend --once`;

export function GraduatedAutonomyArticle({ post }: { post: Post }) {
  return (
    <article aria-labelledby="post-title">
      <header className="manifesto-heading">
        <PostBreadcrumb title={post.title} />
        <p className="eyebrow">Blog</p>
        <h1 id="post-title">{post.title}</h1>
        <p className="manifesto-deck">
          Four modes, one controller, and a fresh init that records autonomous. What still has to be true before a change is approved, deployed, or rolled back.
        </p>
        <p className="post-byline">
          <time dateTime={post.date}>{publishedLabel(post.date)}</time>
          <span>Loopiter</span>
        </p>
      </header>

      <div className="manifesto-body">
        <p>
          The controller has four modes: observe inspects eligible evidence and does not propose a change, recommend stores bounded proposals and does not approve or deploy them, experiment compares candidates and can audit them without deploying, and autonomous can approve, apply, observe, retain, or roll back when self-improving is on and the policy is complete. A fresh init in both languages records autonomous mode and self-improving on, and the plan starts incomplete. The worker refuses to start without <code>--enable</code>, and autonomous mode fails closed without an audit partition, a budget, or that flag.
        </p>
        <p>
          Loopiter, in this repository, is an MIT-licensed library. It captures executions and verified feedback, evaluates an immutable candidate, and coordinates deployment or rollback through adapters your application owns. It is a library, with no hosted scheduler and no daemon in the core. The published npm alpha is <code>loopiter@0.3.0-alpha.1</code> and the published PyPI alpha is <code>loopiter==0.3.0a1</code>. Those archives predate the self-hosted init and worker described here. The commands below are the ones in this source tree. The <Link className="inline-link" href="/">home page</Link> shows the four modes. This note is how the SDK source actually selects among them.
        </p>

        <section aria-labelledby="four-modes">
          <h2 id="four-modes">The four modes</h2>
          <p>
            <code>ImprovementController</code> accepts <code>observe</code>, <code>recommend</code>, <code>experiment</code>, and <code>autonomous</code>. The same four names are the worker modes in both languages. Node options use camelCase. Python arguments use snake_case.
          </p>
          <h3>Observe</h3>
          <p>
            Observe inspects eligible evidence and does not propose a change. Use it when you want the loop to look at what it would be allowed to learn from, and to leave the serving artifact where it is.
          </p>
          <h3>Recommend</h3>
          <p>
            Recommend stores bounded proposals. It does not approve them and it does not deploy them. This is the mode you get from constructing <code>ImprovementController</code> without a mode, in Node and in Python. Self-improving stays off unless you pass the flag.
          </p>
          <h3>Experiment</h3>
          <p>
            Experiment compares candidates, selects one, and can run the independent audit. It does not deploy. Callbacks are ordinary code in your process, and cancellation is cooperative.
          </p>
          <h3>Autonomous</h3>
          <p>
            Autonomous, with self-improving on and a complete policy, can approve, apply, observe, retain, or roll back. A fresh onboarding plan records this mode. Setting the self-improving flag alone does nothing. The application still calls <code>tick</code>. The <a className="inline-link" href={docUrl('autonomous')}>autonomy modes in the documentation</a> describe the same four behaviors and the policy fields around them.
          </p>
        </section>

        <section aria-labelledby="fresh-init">
          <h2 id="fresh-init">What a fresh init records</h2>
          <p>
            <code>loopiter init</code> in both languages writes schemaVersion 2 with preset <code>autonomous-default</code>. The plan sets mode to autonomous and self-improving on. Node writes <code>selfImproving: true</code>. Python writes the same JSON key. The plan also records a step timeout of 120000 milliseconds and a paired-Hoeffding audit block: minimum improvement 0.05, range 0 to 1, alpha 0.05, and 50 minimum units. Those numbers are the plan’s starting settings, written by init. They are not a measured result. minimumImprovement 0.05 is the bound a certified gain must clear, so a gain of 0.05 cannot be certified; at this objective a gain of 0.10 needs 2397 units and a gain of 0.20 needs 267, and doctor only enforces the full-range floor of 7.
          </p>
          <p>
            The plan starts incomplete. The reviewed checklist for target, feedback, evaluation, budgets, and deployment is false. Namespace and storage are unset. <code>doctor</code> checks that declared configuration and does not call a model. <code>verify</code> runs isolated simulated controller paths and does not spend. Initialization does not start a worker.
          </p>
          <p>
            Existing schemaVersion 1 plans are left unchanged. A fresh plan is the one that records autonomous mode.
          </p>
        </section>

        <section aria-labelledby="change-level">
          <h2 id="change-level">How to change the level</h2>
          <p>
            After doctor and verify, the recipe init writes omits <code>--mode</code>. The worker then follows <code>plan.mode</code>. On a fresh plan, that is autonomous. Pass <code>--mode</code> to override the plan: <code>observe</code>, <code>recommend</code>, <code>experiment</code>, or <code>autonomous</code>. With no integration plan file, the worker uses recommend.
          </p>
          <p>
            Set <code>plan.mode</code> to <code>recommend</code> when you want the recipe, which omits the flag, to store proposals and stop before apply. The flag form is <code>--mode recommend</code>. The same pattern selects observe or experiment.
          </p>
          <pre>
            <code>{workerExample}</code>
          </pre>
          <p>
            The worker refuses to start without <code>--enable</code>. That flag authorizes improvement work and provider spending inside the existing gates. It does not bypass validation, audit, minimum improvement, guardrails, trusted sources, budgets, cooldown, the consecutive-failure stop, canary promotion, observation rollback, pause, or lease checks. Omit <code>--once</code> and the process keeps ticking in the foreground, on the interval you set. The CLI default for that interval is 30000 milliseconds. Your process manager has to keep it running. The process does not stay up after it exits.
          </p>
          <p>
            The first enabled autonomous run for a namespace and plan asks for a one-time confirmation. On a terminal, type activate. When stdin is not a terminal, pass <code>--confirm-activation</code> or <code>--yes</code>. The worker stores the consent in <code>.state/activation.json</code>, with who confirmed it and when. The stamp is a consent record. It is not signed, and it is not bound to a machine. The hash covers schema version, effective mode, self-improving, the effective namespace (<code>LOOPITER_NAMESPACE</code> when set, otherwise the plan namespace), the plan step timeout, audit, policy, and budget. A one-off <code>--step-timeout-ms</code> is outside that hash. A later run reuses the stamp. A new namespace, or a change to a hashed field, asks again. A completed checklist or a doctor report is not that confirmation. After the one confirmation, autonomous runs continue without a per-candidate approval.
          </p>
        </section>

        <section aria-labelledby="gates">
          <h2 id="gates">What still gates a change</h2>
          <p>
            Autonomous mode fails closed without an audit partition, a budget, or <code>--enable</code>. The target has to be exact. Node accepts <code>prompt</code>, <code>routing</code>, or <code>agent_release</code>, each with a key. Python accepts <code>prompt</code> or <code>routing</code> only. <code>agent_release</code> is a Node policy target. It is not a tool that edits agent code, spawns agents, or changes topology.
          </p>
          <p>
            The change has to match a bounded schema: permitted fields, required fields, no extra properties, and length or numeric bounds. Only optimization rows reach the proposer. Every candidate is scored against one frozen baseline. The audit split is held out. If you do not supply an audit method, the controller uses a fixed-sample paired Hoeffding bound, and that lower bound has to clear the configured minimum improvement. The assumption recorded with that check is independent units.
          </p>
          <p>
            Each cycle falls back to three proposal calls and three candidates when the policy omits those caps. Three consecutive unsuccessful cycles stop further proposals unless you set <code>maximumConsecutiveFailures</code> (Python: <code>maximum_consecutive_failures</code>). The step timeout defaults to 120000 milliseconds and cannot exceed 7200000 (2 hours). The tick timeout defaults to 600000 milliseconds, lengthened when the step needs the tick to cover it, and cannot exceed 7260000. The Node and Python controllers use those same ceilings. A plan <code>stepTimeoutMs</code> and the <code>--step-timeout-ms</code> flag also stop at 7200000. Daily ceilings for model requests, tokens, and deployments have to be set. There is no unlimited fallback.
          </p>
          <p>
            The policy validator accepts one combination of fallbacks: observation timeout and observation failure roll back, insufficient evidence waits, and an uncertain deployment reconciles. Anything else is rejected as an unsafe fallback. Missing observation data is not treated as success.
          </p>
        </section>

        <section aria-labelledby="rollback">
          <h2 id="rollback">Rollback and pause</h2>
          <p>
            You implement <code>apply</code>, <code>rollback</code>, and <code>inspect</code>. The SDK records the attempt before the external call and finalizes a valid receipt, the candidate state, and the active pointer afterward. An uncertain result stays pending until inspection. Reconcile inspects the saved attempt. It does not blindly reapply. Rollback restores the recorded predecessor.
          </p>
          <p>
            <code>pause(workflowId, reason)</code> in Node, and <code>pause(workflow_id, reason)</code> in Python, blocks new changes. Inspection and an authorized rollback stay available. Pause does not undo a call that has already been sent. <code>resume</code> is an administrative action. Out-of-band edits that the adapter cannot line up with the recorded attempt stay blocked.
          </p>
          <p>
            Immediate rollout freezes further changes while version-specific outcomes mature. Canary mode still needs your application to own traffic assignment. <code>assignCohort</code> (Python: <code>assign_cohort</code>) is a deterministic bucket helper, not a router. Node and Python controllers should not both manage the same external target. Their storage contracts are separate.
          </p>
        </section>

        <section aria-labelledby="calls">
          <h2 id="calls">The calls, in both languages</h2>
          <p>
            The snippets use the real controller API. The workflow, its policy, and its adapters are yours. <code>InMemoryStore</code> is a development store in both SDKs. <code>JsonFileStore</code> is Node-only single-process development storage. Python does not include it. Production storage is an application-owned adapter, such as the optional PostgreSQL pools.
          </p>
          <h3>Node.js</h3>
          <pre>
            <code>{nodeExample}</code>
          </pre>
          <p>
            Node <code>tick</code> takes the workflow id and an optional <code>AbortSignal</code>. The call above uses the default, which is no caller signal. The controller still applies its own step and tick deadlines.
          </p>
          <h3>Python</h3>
          <pre>
            <code>{pythonExample}</code>
          </pre>
          <p>
            Python <code>tick</code> takes the workflow id and an optional <code>asyncio.Event</code> for cancellation. Names on the workflow are <code>optimizer_version</code> and <code>evaluator_version</code>.
          </p>
        </section>

        <section aria-labelledby="language-boundary">
          <h2 id="language-boundary">Where Node and Python differ</h2>
          <p>
            Both languages share the four modes, the fresh-init preset, the <code>--enable</code> gate, and the activation stamp. The autonomous target kind <code>agent_release</code> is accepted by the Node policy validator only. Python’s autonomous targets are <code>prompt</code> and <code>routing</code>.
          </p>
          <p>
            <code>JsonFileStore</code> and its legacy JSON migration CLI are Node-only. The Vercel AI SDK wrapper, <code>loopiter/integrations/ai-sdk</code>, is Node-only. The OpenTelemetry exporter, <code>loopiter/integrations/otel</code>, is Node-only. A trace from that exporter does not authorize an improvement. Optional OpenAI capture wrappers exist in both SDKs. Feedback stays explicit in your code.
          </p>
          <p>
            The <Link className="inline-link" href="/manifesto">manifesto</Link> is the reason for the loop: a useful correction should start the work. The <Link className="inline-link" href="/blog/self-improving-ai-agents-need-a-feedback-loop-you-can-evaluate">note on a feedback loop you can evaluate</Link> is why the proposer does not grade its own change. This page is the switch that decides how far a passing change can go.
          </p>
        </section>
      </div>

      <div className="manifesto-next">
        <Link className="text-link" href="/">
          Loopiter home <span aria-hidden="true">↗</span>
        </Link>
        <Link className="text-link" href="/manifesto">
          Read the manifesto <span aria-hidden="true">↗</span>
        </Link>
        <Link className="text-link" href="/blog/self-improving-ai-agents-need-a-feedback-loop-you-can-evaluate">
          Why a feedback loop has to be evaluable <span aria-hidden="true">↗</span>
        </Link>
        <a className="text-link" href={docUrl('autonomous')}>
          Autonomy modes in the documentation <span aria-hidden="true">↗</span>
        </a>
      </div>
    </article>
  );
}
