"""Loopiter Python: zero runtime dependencies, no telemetry, no automatic deployment."""

from ._validation import LoopiterError, fingerprint
from .client import DeploymentAdapter, FeedbackLoop
from .store import FeedbackStore, InMemoryStore, StoreTransaction

__version__ = "0.2.0a1"
__all__ = [
    "DeploymentAdapter",
    "FeedbackLoop",
    "FeedbackStore",
    "InMemoryStore",
    "LoopiterError",
    "StoreTransaction",
    "fingerprint",
]
