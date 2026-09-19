# Autonomous improvement: design notes and evidence status

This is implementation work for 0.3, not a release or production-enablement notice.
The release checklist remains in `docs/autonomy-release-checklist.md`.

## Lessons incorporated from the supplied BugBasher article

The supplied account describes an agent iterating on prompts and business processes.
It is useful motivation, not evidence that Loopiter itself improves a live system.

- **Activity is not success.** Attempts, requests and deployments are reported separately
  from objective scores and production observation. A completed deployment is not an
  improved model. Business applications should supply a bounded net-value objective
  and explicit cost constraints, not optimize call volume or gross revenue alone.
- **Delayed results need time.** Outcome maturity and minimum observation duration prevent
  a quiet first hour from being mistaken for a failed experiment. Missing data stays
  incomplete; an observation timeout follows the configured recovery policy.
- **Remember failures.** Durable decision keys, callback operations and immutable
  observations survive fresh processes. Unchanged evidence cannot trigger unlimited
  repeated proposal/evaluation calls. Audit reuse is separately prohibited.
  Optimizers receive a bounded history of terminal states/reasons (not audit examples).
  Three consecutive unsuccessful cycles stop further proposal work by default;
  developers can set `maximumConsecutiveFailures` / `maximum_consecutive_failures`.
  Administrative `resume` is logged and resets that stop, but never resets budgets,
  evidence deduplication, audit consumption, or unresolved deployment locks.
- **Not every fault is fixable by a prompt.** A rejected candidate or exhausted budget
  produces an explicit result. The caller can route lifecycle events to its existing
  incident/review system. No automated credential acquisition, code rewriting, contact
  discovery or bypass of permission boundaries is authorized.
- **Bound prompt growth.** Editable fragments require schemas and length limits; safety
  instructions and label definitions remain outside generated content. Regression
  cases should include instruction leakage, unintended disclosure and task-specific failures.
- **Use memory without granting it authority.** Logs and model-written hypotheses are
  proposal context, not trusted labels or permission to alter policy. Application-owned
  scheduling may be periodic or event-driven, but target coordination prevents overlap.

## Scope discipline

Loopiter is not an autonomous company or a general agent runtime. There is no heartbeat
daemon, outbound-contact system, payment tool, subagent spawning or self-modifying code.
Developers own objectives, trusted sources, serving infrastructure and escalation channels.
The SDK coordinates bounded experiments and preserves enough evidence to explain outcomes.
