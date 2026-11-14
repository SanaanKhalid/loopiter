"""Loopiter Python: dependency-free, no telemetry. The controller defaults to autonomous with self-improving on. The worker runs unless --disable or LOOPITER_DISABLE=1 is set."""

from ._validation import LoopiterError, fingerprint
from .client import DeploymentAdapter, FeedbackLoop
from .cohorts import assign_cohort
from .improvement import CallbackContext, ImprovementController, ImprovementWorkflow
from .improvement_evidence import (
    compare,
    minimum_certifiable_audit_units,
    prepare_dataset,
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
    "minimum_certifiable_audit_units",
    "prepare_dataset",
    "validate_change",
    "validate_policy",
]
