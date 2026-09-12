"""Python store contract v1. Namespace-serializable, atomic, short transactions."""

import asyncio
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from copy import deepcopy
from typing import Protocol

from ._validation import (
    COLLECTIONS,
    Record,
    enum,
    fail,
    in_window,
    integer,
    nonempty,
    stored,
    window_valid,
)


class StoreTransaction(Protocol):
    async def get(self, collection: str, key: str) -> Record | None: ...
    async def list(
        self,
        collection: str,
        *,
        limit: int = 100,
        cursor: str | None = None,
        window: Record | None = None,
    ) -> Record: ...
    async def insert(self, collection: str, record: Record) -> None: ...
    async def replace(self, collection: str, record: Record, expected_revision: int) -> None: ...


class FeedbackStore(Protocol):
    version: int

    def transaction(self, namespace: str) -> AbstractAsyncContextManager[StoreTransaction]: ...
    async def delete_namespace(self, namespace: str) -> None: ...
    async def close(self) -> None: ...


def page_options(limit: int, cursor: str | None, window: Record | None) -> None:
    integer(limit, "page limit")
    if limit > 1000:
        fail("query_limit", "Page limit cannot exceed 1000.")
    if cursor is not None:
        nonempty(cursor, "cursor")
    window_valid({} if window is None else window)


class MemoryTransaction:
    def __init__(self, namespace: str, state: Record):
        self.namespace, self.state, self.active = namespace, state, True
        self.owner = asyncio.current_task()

    def check(self, collection: str) -> None:
        if not self.active or asyncio.current_task() is not self.owner:
            fail("transaction_closed", "Transaction closed or used from a different task.")
        enum(collection, COLLECTIONS, "collection")

    async def get(self, collection: str, key: str) -> Record | None:
        self.check(collection)
        nonempty(key, "id")
        return deepcopy(self.state.get(collection, {}).get(key))

    async def list(
        self,
        collection: str,
        *,
        limit: int = 100,
        cursor: str | None = None,
        window: Record | None = None,
    ) -> Record:
        self.check(collection)
        page_options(limit, cursor, window)
        rows = sorted(
            (
                row
                for row in self.state.get(collection, {}).values()
                if (cursor is None or row["id"] > cursor)
                and in_window(
                    row.get("observed_at", row.get("started_at", row["created_at"])), window or {}
                )
            ),
            key=lambda row: row["id"],
        )
        page = {"items": deepcopy(rows[:limit])}
        if len(rows) > limit:
            page["next_cursor"] = rows[limit - 1]["id"]
        return page

    async def insert(self, collection: str, record: Record) -> None:
        self.check(collection)
        stored(collection, record, self.namespace)
        bucket = self.state.setdefault(collection, {})
        if record["id"] in bucket or record["revision"] != 1:
            fail("conflict", "Insert requires a new ID and revision 1.")
        bucket[record["id"]] = deepcopy(record)

    async def replace(self, collection: str, record: Record, expected_revision: int) -> None:
        self.check(collection)
        stored(collection, record, self.namespace)
        integer(expected_revision, "expected_revision")
        if collection in ("signals", "events"):
            fail("immutable_record", "Collection is insert-only.")
        previous = self.state.get(collection, {}).get(record["id"])
        if (
            not previous
            or previous["revision"] != expected_revision
            or record["revision"] != expected_revision + 1
        ):
            fail("conflict", "Revision conflict.")
        self.state[collection][record["id"]] = deepcopy(record)


class InMemoryStore:
    """Development only. One asyncio event loop; no multi-process durability."""

    version = 1

    def __init__(self) -> None:
        self._state: Record = {}
        self._lock = asyncio.Lock()

    @asynccontextmanager
    async def transaction(self, namespace: str):
        nonempty(namespace, "namespace")
        async with self._lock:
            tx = MemoryTransaction(namespace, deepcopy(self._state.get(namespace, {})))
            try:
                yield tx
                self._state[namespace] = deepcopy(tx.state)
            finally:
                tx.active = False

    async def delete_namespace(self, namespace: str) -> None:
        nonempty(namespace, "namespace")
        async with self._lock:
            self._state.pop(namespace, None)

    async def close(self) -> None:
        pass
