import Link from 'next/link';
import { docUrl } from '../lib/docs-links';
import { publishedLabel, type Post } from '../lib/posts';
import { PostBreadcrumb } from './post-breadcrumb';

export function FeedbackLoopArticle({ post }: { post: Post }) {
  return (
    <article aria-labelledby="post-title">
      <header className="manifesto-heading">
        <PostBreadcrumb title={post.title} />
        <p className="eyebrow">Blog</p>
        <h1 id="post-title">{post.title}</h1>
        <p className="manifesto-deck">
          A model that rewrites its own prompt is not a feedback loop. The loop is the evidence, the check, and a decision you can defend to keep or revert the change.
        </p>
        <p className="post-byline">
          <time dateTime={post.date}>{publishedLabel(post.date)}</time>
          <span>Loopiter</span>
        </p>
      </header>

      <div className="manifesto-body">
        <p>
          Teams call an agent self-improving when a later run behaves differently because an earlier run produced something: a failed test, a correction, a stored note, a new skill. The change is often not a weight update. This note separates that idea from the narrower thing the Loopiter SDK in this repository actually coordinates, and it points at the public sources behind the general claims.
        </p>

        <section aria-labelledby="what-changes">
          <h2 id="what-changes">What “self-improving” usually changes</h2>
          <p>
            <a className="inline-link" href="https://arxiv.org/abs/2303.11366">Reflexion (Shinn et al., NeurIPS 2023)</a> does not fine-tune the model. The agent reflects on task feedback in language and keeps that reflection in an episodic memory buffer for the next trial. <a className="inline-link" href="https://arxiv.org/abs/2303.17651">Self-Refine (Madaan et al., NeurIPS 2023)</a> uses the same model to critique an output and then revise it. <a className="inline-link" href="https://arxiv.org/abs/2305.16291">Voyager (Wang et al., 2023)</a> stores programs that passed an environment check in a skill library and retrieves them later. These are research systems with different tasks and evidence. They share one mechanism: the next attempt receives an artifact the last attempt produced.
          </p>
          <p>
            That artifact might be a prompt edit, a retrieved note, a routing rule, or a file the harness is allowed to write. Any of those can change behavior. None of them is, by itself, an improvement. A second customer can still get the wrong warranty period if the only thing that happened was an apology in the first conversation. The <Link className="inline-link" href="/manifesto">manifesto</Link> is about that gap. The rest of this post is about the check that has to sit in it.
          </p>
        </section>

        <section aria-labelledby="why-evaluation">
          <h2 id="why-evaluation">Why the loop has to be evaluable</h2>
          <p>
            <a className="inline-link" href="https://arxiv.org/abs/2310.01798">Huang et al. (ICLR 2024)</a> studied intrinsic self-correction: a model revising its own answer with no external feedback. On reasoning benchmarks, accuracy often fell. Where earlier papers reported gains, the improvements depended on oracle labels telling the model it was wrong. If the system already has the answer, it is not discovering one, and it is not a production feedback signal.
          </p>
          <p>
            <a className="inline-link" href="https://www.anthropic.com/research/demystifying-evals-for-ai-agents">Anthropic’s January 2026 note on agent evals</a> describes the same failure in a team that ships. Without evals, regressions show up as user complaints, and nobody can separate a real behavior change from noise. They define an evaluation harness as the infrastructure that runs tasks, records transcripts, grades them, and aggregates results. They define an agent harness, or scaffold, as the system that lets a model act: it takes inputs, runs tool calls, and returns results. Evaluating “the agent” means evaluating the harness and the model together.
          </p>
          <p>
            <a className="inline-link" href="https://www.anthropic.com/engineering/building-effective-agents">Their earlier agent guide</a> names one workflow an evaluator-optimizer: one model generates, another evaluates and feeds the critique back. <a className="inline-link" href="https://arxiv.org/abs/2405.15793">SWE-agent (Yang et al., 2024)</a> makes a related point about the harness itself. The agent-computer interface — the commands and observations the model is given — changes how often software-engineering tasks are resolved, not only which model is behind it.
          </p>
          <p>
            A loop you can keep has an outside check. The proposer does not grade its own change on the cases that decide whether the change ships. The check has a version, a dataset, and a record of what was deployed, including a previous version you can restore.
          </p>
        </section>

        <section aria-labelledby="patterns">
          <h2 id="patterns">Four patterns, and what they are not</h2>
          <h3>Evals</h3>
          <p>
            An eval is a task, one or more trials, and graders. Anthropic separates code-based, model-based, and human graders, and separates the transcript from the outcome in the environment. A support agent can say the refund was issued while the database says it was not. For a prompt change, the useful eval is a held-out set of inputs and labels, scored against the current version. A single transcript that reads better is not that eval.
          </p>
          <h3>Reflection</h3>
          <p>
            Reflection is a written critique of a failed attempt, reused as context. Reflexion is the reference design: turn task feedback into text and keep it for the next episode. It is useful when the feedback is real, such as a failed test, a tool error, or a person correcting the answer. It does not replace that feedback. The Huang et al. result is the warning on “ask the model whether it was wrong.”
          </p>
          <h3>Memory</h3>
          <p>
            Memory is state the next run can read. Reflexion’s buffer is episodic memory. Voyager’s skill library is a set of programs. <a className="inline-link" href="https://arxiv.org/abs/2310.08560">MemGPT (Packer et al., 2023)</a> pages information between the context window and external storage. A note the model wrote about itself is not a regression set, and a durable store of verified labels is a different object from either of those memories.
          </p>
          <h3>Harnesses</h3>
          <p>
            The harness is the loop around the model: which tools exist, when the loop stops, what is logged, and what the process is allowed to change. A harness can make an agent look self-improving while the only durable change is a file an unattended script was permitted to write. The harness is part of the system you have to evaluate. It is not evidence that the change was better.
          </p>
        </section>

        <section aria-labelledby="how-loopiter">
          <h2 id="how-loopiter">How Loopiter approaches the loop</h2>
          <p>
            Loopiter, in this repository, is an MIT-licensed library for that loop. The published alpha is <code>0.3.0-alpha.1</code> on npm and <code>0.3.0a1</code> on PyPI, for Node.js 22 or 24 and Python 3.11+. Those published archives predate the self-hosted init and worker in this source tree. It is a library. A hosted product, a model, and a trainer are outside this package. The core has no runtime dependencies and sends no telemetry. You bring storage, model calls, evaluation, scheduling, and deployment. Canonical documentation is in the <a className="inline-link" href={docUrl('overview')}>overview</a> and the <a className="inline-link" href={docUrl('supported')}>capability matrix</a>.
          </p>
          <p>
            The path the SDK coordinates is the one the overview names: capture an execution, attach verified feedback, analyze scored segments, propose a bounded change, and evaluate it. Approval, deployment, observation, and rollback run when the mode and the policy allow them. A fresh self-hosted init in this repository records autonomous mode and self-improving on. Installing a package does not start a worker. The <Link className="inline-link" href="/">landing page</Link> describes the product direction, including prompt and knowledge changes that go live when they pass. The SDK that is in the repo is narrower than that sentence. Read the limits below before treating the page as a feature list.
          </p>
          <h3>Capture is not a label</h3>
          <p>
            <code>FeedbackLoop</code> records executions whose kinds are <code>agent</code>, <code>turn</code>, <code>inference</code>, <code>prediction</code>, <code>tool</code>, <code>workflow</code>, <code>retrieval</code>, or <code>custom</code>. Signals are <code>rating</code>, <code>correction</code>, <code>outcome</code>, <code>reward</code>, <code>approval</code>, <code>tool_result</code>, or <code>custom</code>. Creation is insert-only inside a namespace. A namespace is an integrity scope, not authentication. The overview is explicit that captured messages are not trustworthy training labels. The application supplies verified corrections or outcomes and chooses who is allowed to write them.
          </p>
          <h3>Analysis describes segments</h3>
          <p>
            The analyzer builds structured dimension segments and weighted episode or execution scores, and it reports evidence counts. It does not do embeddings, free-text clustering, causal inference, or a probability that a change will help. You define the scores.
          </p>
          <h3>Reflection is your callback, if you want one</h3>
          <p>
            The SDK does not ship a reflector. <code>ImprovementWorkflow.propose</code> is an application callback. It receives the current artifact, example rows, and previous outcomes, and it returns JSON values. You can put a reflection step there. You still do not let that step grade itself. The <a className="inline-link" href={docUrl('evaluation')}>evaluation guide</a> says the Node classification starter keeps labels, system instructions, evaluator code, and acceptance thresholds outside the generated prompt fragment. The proposing model never grades itself. Passing a small holdout is not treated as proof of a production improvement.
          </p>
          <h3>Evaluation is versioned and split</h3>
          <p>
            A workflow carries <code>optimizerVersion</code> and <code>evaluatorVersion</code> (Python: <code>optimizer_version</code> and <code>evaluator_version</code>). The dataset snapshot has optimization, validation, and audit rows. <code>evaluate</code> returns a comparison: one baseline score and one candidate score per unit, plus metrics. Policy adds an objective (metric, direction, declared range, minimum improvement) and independent guardrail gates. On the audit split, if you do not supply your own audit method, the controller computes a fixed-sample paired Hoeffding lower bound and requires that bound to clear the minimum improvement. The recorded note states the assumption: independent units. A custom method is accepted only when its name, version, and assumptions match the policy, and when its lower bound is consistent with the bounded scores.
          </p>
          <p>
            Candidate content and evidence are hashed. An approval is tied to the exact passing evaluation of that content. The evaluator is a versioned callback you provide. Loopiter stores the evidence and protects the lifecycle transition. It does not invent the task.
          </p>
          <h3>What a fresh setup records</h3>
          <p>
            <code>ImprovementController</code> modes are <code>observe</code>, <code>recommend</code>, <code>experiment</code>, and <code>autonomous</code>. A fresh <code>init</code> writes schemaVersion 2 with preset <code>autonomous-default</code>: mode <code>autonomous</code> and self-improving on, in Node and in Python. The plan starts incomplete. Constructing the controller without a mode stays on <code>recommend</code> with self-improving off: it can store bounded proposals and does not approve or deploy them. Observe inspects evidence without proposing. Experiment compares candidates and can audit them without deployment. Autonomous approval and deployment need <code>selfImproving: true</code> (Python: <code>self_improving=True</code>), <code>mode</code> set to <code>autonomous</code>, and a complete policy. Setting the flag alone does nothing. The application calls <code>tick</code>. There is no hosted scheduler and no daemon in the core. <Link className="inline-link" href="/blog/graduated-autonomy-for-self-improving-ai-agents">Graduated autonomy for self-improving agents</Link> walks through the modes, and the <a className="inline-link" href={docUrl('autonomous')}>autonomy modes in the documentation</a> are the longer reference.
          </p>
          <p>
            The self-hosted worker is a process you start. After doctor and verify, the init recipe omits <code>--mode</code>, so <code>plan.mode</code> controls it. Node: <code>npx --no-install loopiter worker --module ./loopiter/application.mjs --enable --once</code>. Python: <code>python -m loopiter worker --module loopiter/application.py --enable --once</code>. Without <code>--enable</code> the worker refuses to run. <code>--mode</code> overrides the plan. With no integration plan, the worker uses <code>recommend</code>. The first autonomous run asks you to type activate on a terminal, or to pass <code>--confirm-activation</code> or <code>--yes</code> when stdin is not a terminal. Later runs reuse that consent record until the hashed plan settings change. Installing the package does not start the worker.
          </p>
          <p>
            A cycle stops at the policy’s caps on proposal calls and candidates. The controller’s fallback is three of each, and three consecutive unsuccessful cycles stop proposals unless the policy sets another cap. The step timeout defaults to 120000 milliseconds and cannot exceed 3600000. The tick timeout defaults to 600000 milliseconds, or longer when the step needs it, and cannot exceed 3660000. The policy has to set daily ceilings for model requests, tokens, and deployments. There is no unlimited fallback. Callbacks run in your process, with your credentials. Cancellation is cooperative.
          </p>
          <h3>Deployment stays an adapter</h3>
          <p>
            You implement <code>apply</code>, <code>rollback</code>, and <code>inspect</code>. The SDK records the attempt before the external call and finalizes a valid receipt, the candidate state, and the active pointer afterward. An uncertain result stays pending until inspection. Reconcile inspects; it does not blindly reapply. Rollback restores the recorded predecessor, not whatever version is newest. There is no exactly-once claim across your database and the system you deploy to.
          </p>
          <p>
            The policy’s rollout is <code>immediate</code> or <code>canary</code>. Canary mode coordinates promotion and withdrawal and asks for an externally computed comparison. Assigning traffic, and keeping that assignment stable, is the application’s job. Observation failure or timeout is specified as rollback, through your adapter. The README records one isolated Azure demonstration: a completed Node cycle and receipt recovery with live calls and synthetic labels. That is not production customer-impact evidence.
          </p>
          <h3>What the library does not contain</h3>
          <p>
            The policy validator accepts an autonomous target only when its kind is <code>prompt</code> or <code>routing</code>, and the target has an exact key. The Node validator also accepts <code>agent_release</code>. Python does not. The change has to match a bounded schema: permitted fields, required fields, no extra properties, and length or numeric bounds. <code>agent_release</code> is a Node target kind the validator allows. It is not a tool that edits agent code, spawns agents, or changes topology. Other target kinds can be represented, evaluated, and deployed by hand through an adapter. They include retrieval, rules, models, datasets, tool schemas, and workflows. <a className="inline-link" href={docUrl('agentSystems')}>Agent systems</a> is explicit that code, capacity, and agent topology are categories only. The SDK does not discover tools, spawn agents, edit code, or scale workers.
          </p>
          <p>
            <a className="inline-link" href={docUrl('fineTuning')}>Fine-tuning</a> is out of the alpha. A <code>model</code> or <code>dataset</code> candidate describes a proposal and its evidence. It is not a training job, and it cannot take the autonomous deployment path. Captured ratings are not training-ready data.
          </p>
          <p>
            There is no Reflexion buffer and no MemGPT-style memory manager. Both SDKs include <code>InMemoryStore</code> as a development store for records, not as agent memory and not as the production write path. <code>JsonFileStore</code> is Node-only single-process development storage. Python does not include it. <code>replaceGuidance</code> (Python: <code>replace_guidance</code>) inserts a released guidance block into system or developer messages and strips the previous block. That is prompt assembly for a version you already chose. It is not a learned memory. Optional OpenAI wrappers can capture calls in both SDKs. The Vercel AI SDK wrapper is Node-only. Feedback, and the choice of what to release, stay in your code. The OpenTelemetry exporter (<code>loopiter/integrations/otel</code>) is Node-only. A trace does not authorize an improvement, and it is not a replay of the application.
          </p>
          <p>
            Write the evaluator against cases the proposer does not control. Keep a previous artifact you can restore. Autonomous mode fails closed without an audit partition, a budget, and <code>--enable</code>. The policy validator accepts observation timeout and failure only as rollback. The <a className="inline-link" href={docUrl('selfImprovement')}>governed self-improvement notes</a> describe the older recipe API and point forward to that controller. A run can end with no candidate passed. The fine-tuning notes call that a normal outcome.
          </p>
        </section>

        <section aria-labelledby="references">
          <h2 id="references">Sources</h2>
          <p>
            The papers and essays below are the sources for the general claims about agents, evals, reflection, memory, and harnesses. Statements about Loopiter refer to the SDK and docs in this repository, linked inline.
          </p>
          <ol className="reference-list">
            <li>Shinn et al. <a className="inline-link" href="https://arxiv.org/abs/2303.11366">Reflexion: Language Agents with Verbal Reinforcement Learning</a>. NeurIPS 2023.</li>
            <li>Madaan et al. <a className="inline-link" href="https://arxiv.org/abs/2303.17651">Self-Refine: Iterative Refinement with Self-Feedback</a>. NeurIPS 2023.</li>
            <li>Wang et al. <a className="inline-link" href="https://arxiv.org/abs/2305.16291">Voyager: An Open-Ended Embodied Agent with Large Language Models</a>. 2023.</li>
            <li>Packer et al. <a className="inline-link" href="https://arxiv.org/abs/2310.08560">MemGPT: Towards LLMs as Operating Systems</a>. 2023.</li>
            <li>Huang et al. <a className="inline-link" href="https://arxiv.org/abs/2310.01798">Large Language Models Cannot Self-Correct Reasoning Yet</a>. ICLR 2024.</li>
            <li>Anthropic. <a className="inline-link" href="https://www.anthropic.com/engineering/building-effective-agents">Building effective agents</a>. 19 December 2024.</li>
            <li>Anthropic. <a className="inline-link" href="https://www.anthropic.com/research/demystifying-evals-for-ai-agents">Demystifying evals for AI agents</a>. 9 January 2026.</li>
            <li>Yang et al. <a className="inline-link" href="https://arxiv.org/abs/2405.15793">SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering</a>. 2024.</li>
          </ol>
        </section>
      </div>

      <div className="manifesto-next">
        <Link className="text-link" href="/">Loopiter home <span aria-hidden="true">↗</span></Link>
        <Link className="text-link" href="/manifesto">Read the manifesto <span aria-hidden="true">↗</span></Link>
        <Link className="text-link" href="/blog/graduated-autonomy-for-self-improving-ai-agents">Graduated autonomy for self-improving agents <span aria-hidden="true">↗</span></Link>
        <a className="text-link" href={docUrl('autonomous')}>Autonomy modes in the documentation <span aria-hidden="true">↗</span></a>
        <a className="text-link" href={docUrl('overview')}>Read the documentation <span aria-hidden="true">↗</span></a>
      </div>
    </article>
  );
}
