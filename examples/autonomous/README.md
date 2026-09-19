# Autonomous workflow examples (0.3 source preview)

These are **simulated, isolated applications**, not live-model improvement evidence.
The SDK never starts a scheduler. The demos repeatedly call `tick` and advance a
simulation clock. They calculate outcomes from deterministic predictions.

```sh
npm ci
npm run build
node dist/examples/autonomous/demo.js prompt accepted
node dist/examples/autonomous/demo.js models interrupted
node dist/examples/autonomous/demo.js decision regression
python -m pip install -e ./python
python python/examples/autonomous_demo.py prompt accepted
python python/examples/autonomous_demo.py models rejected
python python/examples/autonomous_demo.py decision insufficient
```

All three kinds support `accepted`, `rejected`, `insufficient`, `interrupted` and
`regression`. Injected failures are labeled; no real customers are affected. Prompt
fragments leave safety/labels outside generated content. Model routing optimizes
measured serving cost subject to constraints. Decision routing changes only a threshold;
fixed classifier weights, abstention cost and coverage rules prevent trivial escalation.

## Use application data and infrastructure

1. Apply the explicit SDK database migrations to your developer-owned PostgreSQL database.
2. Supply immutable, versioned optimization/validation/audit snapshots from authorized
   feedback, disjoint by episode/entity and time. Factories accept arbitrary customer IDs.
3. Use your real versioned registry implementing current/get/apply/inspect/rollback.
   `postgres-registry.ts` and `python/examples/autonomous_registry.py` are application-side
   PostgreSQL references: explicitly run their migrations, seed an initial artifact and
   pinned configuration hash, then read `current()` on subsequent inference requests.
   They atomically fence both artifact version and configuration, persist receipts, and
   prevent late apply after a fenced inspection. Node/Python own separate tables/targets.
   These immediate-rollout adapters do not implement canary traffic management.
   Never use the older reviewed starter registry for autonomous changes without adding
   configuration fencing. In-memory registries are development-only.
4. Replace simulated predictions/proposals with optional provider wrappers or your own adapters.
   Node reuses native-fetch OpenAI/Azure Responses implementations. Python has a stdlib
   application-side wrapper. Explicit live enablement sends input data to the provider.
   Configure exact models/deployments, limits, upper token reservations and token prices.
5. Supply a production observation adapter over mature version-attributed outcomes; do not
   reuse optimization/validation/audit data as production evidence. Check missing telemetry.
6. Configure trusted objectives/constraints and run under `experiment` before enabling both
   `autonomous` and the self-improvement flag in an isolated application.

There is no automatic credential discovery, model provisioning, training or arbitrary code
execution. The optional `fixed_sklearn.py` bridge accepts an already-fitted linear classifier;
install scikit-learn separately, never load untrusted pickle files, and fingerprint preprocessing.
Pass its `fingerprint` method (not just an initial string) as `model_fingerprint` so artifact
checks re-read weights/configuration before deployment. The bridge also rejects changed weights
before prediction. Models with other internals need their own fingerprint adapter.

The complete optional scikit-learn demo fits a tiny **synthetic setup model before**
the cycle, freezes its weights and feature mapping, then searches only routing
thresholds. It uses real `predict_proba` calls, but its labels, time and observation
traffic are simulated. The output includes before/after model fingerprints.

```sh
python -m pip install 'scikit-learn>=1.6,<2'
python python/examples/sklearn_decision_demo.py accepted
python python/examples/sklearn_decision_demo.py regression
```

It also supports `rejected`, `insufficient` and `interrupted`. This is not automatic
model training or evidence of improved performance on real customers.

## Retained evidence

Offline reports can be generated from these commands. CI runs no live calls. Retain
the Node simulation matrix via `node scripts/autonomy-report.mjs REPORT.json`
(or `python scripts/autonomy-report.py REPORT.json --sklearn` for the Python matrix
including the optional fitted-classifier example)
(the output path must not exist). Reports label simulated clocks, synthetic labels and
injected failures separately from actual external model work. The subsequently authorized
Node/Azure demonstration is retained in `reports/autonomy-live-azure-summary.md`: live calls,
synthetic labels, an isolated PostgreSQL deployment and injected receipt recovery.
It is not live Python or customer-impact evidence. A failed proposal remains a valid outcome.
See `docs/autonomy-release-checklist.md`; no publication is performed by these examples.
# Realistic mock integration

See [the mock support lab](MOCK-SUPPORT.md) for an HTTP application backed by PostgreSQL,
captured corrections, independent scheduler workers, serving-version changes, and recovery.
It makes no live model calls and explicitly labels its synthetic inputs and simulated clock.
