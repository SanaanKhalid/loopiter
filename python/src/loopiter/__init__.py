"""Loopiter Python: dependency-free, no telemetry. The controller defaults to autonomous with self-improving on. The worker runs unless --disable or LOOPITER_DISABLE=1 is set."""

from ._validation import LoopiterError, fingerprint
from .acceptance_gate import (
    decide_retention,
    empty_retention_ledger,
    next_best_ever,
    not_measured_retention,
    remember_retention_decision,
)
from .client import DeploymentAdapter, FeedbackLoop
from .cohorts import assign_cohort
from .improvement import (
    CallbackContext,
    ImprovementController,
    ImprovementWorkflow,
    warn_ambiguous_improvement_disable,
)
from .improvement_evidence import (
    compare,
    minimum_certifiable_audit_units,
    prepare_dataset,
    promotion_retention,
    validate_change,
    validate_policy,
)
from .store import FeedbackStore, InMemoryStore, StoreTransaction

__version__ = "0.3.0a1"
__all__ = [
    "DeploymentAdapter",
    "FeedbackLoop",
    "FeedbackStore",
    "InMemoryStore",
    "LoopiterError",
    "StoreTransaction",
    "fingerprint",
    "assign_cohort",
    "CallbackContext",
    "ImprovementController",
    "ImprovementWorkflow",
    "compare",
    "decide_retention",
    "empty_retention_ledger",
    "minimum_certifiable_audit_units",
    "next_best_ever",
    "not_measured_retention",
    "prepare_dataset",
    "promotion_retention",
    "remember_retention_decision",
    "validate_change",
    "validate_policy",
    "warn_ambiguous_improvement_disable",
]
