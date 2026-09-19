"""Stable assignment helper; the application owns durable exposure and traffic routing."""

import hashlib

from . import _validation as v


def assign_cohort(*, experiment_id: str, entity_id: str, salt: str, exposure: float):
    for name, value in [("experiment_id", experiment_id), ("entity_id", entity_id), ("salt", salt)]:
        v.nonempty(value, name)
    v.finite(exposure, "exposure", 0)
    if exposure > 1:
        v.fail("invalid_input", "Exposure must be in [0,1].")
    framed = "".join(
        f"{len(value.encode('utf-8'))}:{value}" for value in (experiment_id, entity_id, salt)
    )
    digest = hashlib.sha256(framed.encode("utf-8")).hexdigest()
    bucket = int(digest[:13], 16) / 2**52
    return {
        "cohort": "candidate" if bucket < exposure else "control",
        "bucket": bucket,
        "method": "sha256-framed-v1",
        "entity_fingerprint": digest,
    }
