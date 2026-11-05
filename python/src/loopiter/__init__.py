"""Loopiter Python: dependency-free, no telemetry, reviewed by default; autonomy is opt-in."""

from ._validation import LoopiterError, fingerprint
from .client import (
    CandidateInput,
    CompleteExecutionInput,
    DeploymentAdapter,
    ExecutionInput,
    FeedbackLoop,
    SignalInput,
)
from .cohorts import CohortAssignment, assign_cohort
from .improvement import CallbackContext, ImprovementController, ImprovementWorkflow
from .improvement_evidence import (
    AutonomyPolicy,
    compare,
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
    "AutonomyPolicy",
    "CallbackContext",
    "CandidateInput",
    "CohortAssignment",
    "CompleteExecutionInput",
    "ExecutionInput",
    "ImprovementController",
    "ImprovementWorkflow",
    "SignalInput",
    "compare",
    "prepare_dataset",
    "validate_change",
    "validate_policy",
]
