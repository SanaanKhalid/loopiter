# Supported alpha capabilities

## Language availability

| Capability | Node.js 22/24 (npm alpha) | Python 3.11+ (PyPI alpha) |
| --- | --- | --- |
| Capture, structured analysis, manual evaluate/approve/deploy/recover/rollback | Yes | Yes, native async API with snake_case dictionary records |
| Dependency-free core / no telemetry | Yes | Yes |
| Optional PostgreSQL 16/17 | Developer-owned `pg` pool, v2 Node contract | Developer-owned psycopg async pool, v1 Python contract, separate migration/tables/locks |
| In-memory development store / conformance suite | Yes | Yes |
| JsonFileStore and legacy data migration | Yes | Not included |
| Governed controller and experimental auto-apply | Yes | Not included; explicit application calls only |
| OpenAI/Azure classification starter | Yes | Not ported; offline routing fixture example provided |
| Distribution | `npm install loopiter@alpha` | `python -m pip install 'loopiter==0.2.0a1'` |

Python and Node are separate lifecycle owners, not a shared-record/wire protocol.
Do not independently deploy both SDKs to the same external target. See
[Python setup and boundaries](python/README.md).

## Node SDK details

| Capability | SDK/reference implementation | Application responsibility / limitation |
| --- | --- | --- |
| Runtime | ESM TypeScript/JavaScript on Node 22 and 24 | Not a browser/edge SDK; native Python alpha is described above |
| Capture | Scoped insert-only executions/signals, revisions, validation, payload limit, sanitizer | Authentication, verified labels, semantic idempotency keys |
| Analysis | Structured dimension segments; weighted episode/execution scores; independent cohort/observation windows | Define useful scores; no causal inference, embeddings, free-text clustering or probability of improvement |
| Storage | v2 contract; PostgreSQL 16/17 reference; explicit SQL migration | Own `pg` pool, TLS, backups, restore tests, database permissions |
| Development stores | InMemoryStore and single-process JsonFileStore | Not supported for multi-process production writes |
| Evaluation | Versioned callback, immutable evidence/content references, finite metrics | Representative holdouts, independent gates, model drift assessment |
| Deployment | Pending attempts, active pointer, receipts, reconciliation and rollback lineage | Real idempotent apply/inspect/rollback; fences; no out-of-band target writes |
| Controller | Recommend default; 3 proposals/3 candidates, 10 min run, 2 min callback defaults | Scheduling, cost policy, trusted callbacks, process isolation |
| Auto-apply | Explicit experimental low-risk prompt/routing only with metric gates | Not a guarantee of safe/universal autonomous improvement |
| Starter | OpenAI/Azure OpenAI Responses via fetch, PostgreSQL prompt registry, exact-match evaluation, CLI | User credentials/model or Azure deployment; synthetic example dataset must be replaced for customer claims |
| Other target kinds | Represent, recommend, evaluate and manually deploy through adapters | No built-in fine-tuning/training, code deployment, agent spawning or capacity scaling |
| Telemetry / operations | Durable lifecycle events and structured controller reasons; no Loopiter telemetry | Existing logger, alerting, jobs, retention and incident response |
| Hosted product | None | No dashboard, accounts, billing, SLA or managed service |

An alpha is limited in scope, not permitted to silently corrupt data. Tests exercise
fault boundaries, but are not security, statistical, performance or compliance certification.
