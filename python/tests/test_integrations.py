import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from loopiter import FeedbackLoop, InMemoryStore, LoopiterError
from loopiter.integrations.context import replace_guidance, strip_guidance
from loopiter.integrations.openai import with_loopiter

RESULT = {
    "id": "chat-1",
    "choices": [{"index": 0, "message": {"content": "hello"}, "finish_reason": "stop"}],
    "usage": {"total_tokens": 3},
}
PARAMS = {"model": "fixture", "messages": [{"role": "user", "content": "hello"}]}


class Stream:
    def __init__(self, events):
        self.events, self.closed = iter(events), False

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self.events)
        except StopIteration:
            raise StopAsyncIteration from None

    async def close(self):
        self.closed = True


class IntegrationTests(unittest.IsolatedAsyncioTestCase):
    def setup_capture(self, namespace="capture", **kwargs):
        loop = FeedbackLoop(store=InMemoryStore(), namespace=namespace)
        create = AsyncMock(return_value=RESULT)
        base = SimpleNamespace(
            chat=SimpleNamespace(completions=SimpleNamespace(create=create)),
            responses=SimpleNamespace(create=AsyncMock(return_value={"status": "incomplete"})),
        )
        wrapped = with_loopiter(
            base, loop=loop, context=lambda _request: {"artifacts": {"prompt": "v1"}}, **kwargs
        )
        return loop, create, base, wrapped

    async def rows(self, loop):
        return (await loop.list("executions"))["items"]

    async def test_pending_precedes_provider_and_feedback_is_explicit(self):
        loop, create, _base, wrapped = self.setup_capture()

        async def generate(**_params):
            self.assertEqual(
                (await self.rows(loop))[0]["metadata"]["loopiter_capture"]["status"], "pending"
            )
            return RESULT

        create.side_effect = generate
        self.assertIs(await wrapped.chat.completions.create(**PARAMS), RESULT)
        row = (await self.rows(loop))[0]
        self.assertEqual(row["metadata"]["loopiter_capture"]["status"], "completed")
        self.assertEqual(row["output"]["usage"]["total_tokens"], 3)
        self.assertEqual((await loop.list("signals"))["items"], [])

    async def test_client_and_rewrapping_isolation(self):
        a, create, base, first = self.setup_capture("a")
        b = FeedbackLoop(store=InMemoryStore(), namespace="b")
        first = with_loopiter(
            first, loop=a, context=lambda _: {"artifacts": {"prompt": "a"}, "guidance": "tenant-a"}
        )
        second = with_loopiter(
            first, loop=b, context=lambda _: {"artifacts": {"prompt": "b"}, "guidance": "tenant-b"}
        )
        await asyncio.gather(
            first.chat.completions.create(**PARAMS), second.chat.completions.create(**PARAMS)
        )
        prompts = [str(call.kwargs) for call in create.call_args_list]
        self.assertEqual(sum("tenant-a" in prompt for prompt in prompts), 1)
        self.assertEqual(sum("tenant-b" in prompt for prompt in prompts), 1)
        self.assertIs(base.chat.completions.create, create)
        self.assertEqual(PARAMS["messages"], [{"role": "user", "content": "hello"}])
        self.assertEqual(len(await self.rows(a)), 1)
        self.assertEqual(len(await self.rows(b)), 1)

    async def test_duplicate_ids_and_closed_store_prevent_dispatch(self):
        loop, create, base, _wrapped = self.setup_capture()
        wrapped = with_loopiter(base, loop=loop, context=lambda _: {"id": "same", "artifacts": {}})
        await wrapped.chat.completions.create(**PARAMS)
        with self.assertRaisesRegex(Exception, "different input"):
            await wrapped.chat.completions.create(**PARAMS)
        self.assertEqual(create.await_count, 1)
        await loop.close()
        with self.assertRaises(LoopiterError):
            await wrapped.chat.completions.create(**PARAMS)
        self.assertEqual(create.await_count, 1)

    async def test_stream_draining_and_early_context_exit(self):
        for cancel in (False, True):
            loop, create, _base, wrapped = self.setup_capture()
            source = Stream(
                [
                    {
                        "choices": [
                            {"index": 0, "delta": {"content": "hello"}, "finish_reason": None}
                        ]
                    },
                    {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
                    {"choices": [], "usage": {"total_tokens": 3}},
                ]
            )
            create.return_value = source
            async with await wrapped.chat.completions.create(**PARAMS, stream=True) as stream:
                async for _event in stream:
                    if cancel:
                        break
            row = (await self.rows(loop))[0]
            self.assertEqual(
                row["metadata"]["loopiter_capture"]["status"],
                "cancelled" if cancel else "completed",
            )
            self.assertTrue(source.closed)

    async def test_truncation_and_overflow(self):
        for overflow in (False, True):
            loop, create, _base, wrapped = self.setup_capture(
                maximum_output_bytes=20 if overflow else 65536
            )
            create.return_value = Stream(
                [{"choices": [{"index": 0, "delta": {"content": "hello"}, "finish_reason": None}]}]
            )
            stream = await wrapped.chat.completions.create(**PARAMS, stream=True)
            if overflow:
                with self.assertRaisesRegex(ValueError, "maximum_output_bytes"):
                    async for _event in stream:
                        pass
            else:
                async for _event in stream:
                    pass
            self.assertNotEqual(
                (await self.rows(loop))[0]["metadata"]["loopiter_capture"]["status"], "completed"
            )

    async def test_failure_and_responses(self):
        loop, create, _base, wrapped = self.setup_capture()
        create.side_effect = ValueError("provider failure")
        with self.assertRaisesRegex(ValueError, "provider failure"):
            await wrapped.chat.completions.create(**PARAMS)
        self.assertEqual(
            (await self.rows(loop))[0]["metadata"]["loopiter_capture"]["status"], "failed"
        )
        await wrapped.responses.create(model="fixture", input="hello")
        self.assertEqual(
            sorted(row["metadata"]["loopiter_capture"]["status"] for row in await self.rows(loop)),
            ["failed", "incomplete"],
        )

    async def test_transport_headers_are_not_captured(self):
        loop, create, _base, wrapped = self.setup_capture()
        await wrapped.chat.completions.create(**PARAMS, extra_headers={"Authorization": "private"})
        self.assertIn("extra_headers", create.call_args.kwargs)
        self.assertNotIn("private", str(await self.rows(loop)))
        with self.assertRaises(TypeError):
            _ = wrapped.chat.completions.with_raw_response

    def test_context_replacement(self):
        original = "Protected.\n\n"
        updated = replace_guidance(replace_guidance(original, "old"), "new </loopiter>")
        self.assertEqual(strip_guidance(updated), original)
        self.assertNotIn("old", updated)
        self.assertIn("&lt;/loopiter&gt;", updated)

    async def test_post_dispatch_persistence_failure_remains_pending(self):
        loop, create, _base, wrapped = self.setup_capture()
        loop.complete_execution = AsyncMock(side_effect=ValueError("finalization unavailable"))
        with self.assertRaisesRegex(ValueError, "finalization unavailable"):
            await wrapped.chat.completions.create(**PARAMS)
        self.assertEqual(create.await_count, 1)
        self.assertEqual(
            (await self.rows(loop))[0]["metadata"]["loopiter_capture"]["status"], "pending"
        )

    async def test_cancelled_task_is_not_reported_completed(self):
        loop, create, _base, wrapped = self.setup_capture()
        started = asyncio.Event()

        async def wait(**_params):
            started.set()
            await asyncio.Event().wait()

        create.side_effect = wait
        task = asyncio.create_task(wrapped.chat.completions.create(**PARAMS))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(
            (await self.rows(loop))[0]["metadata"]["loopiter_capture"]["status"], "cancelled"
        )

    async def test_request_snapshot_precedes_async_context(self):
        loop, create, base, _wrapped = self.setup_capture()
        entered, proceed = asyncio.Event(), asyncio.Event()

        async def context(_request):
            entered.set()
            await proceed.wait()
            return {"artifacts": {"prompt": "v1"}}

        wrapped = with_loopiter(base, loop=loop, context=context)
        messages = [{"role": "user", "content": "original"}]
        task = asyncio.create_task(
            wrapped.chat.completions.create(model="fixture", messages=messages)
        )
        await entered.wait()
        messages[0]["content"] = "changed"
        proceed.set()
        await task
        self.assertEqual(create.call_args.kwargs["messages"][0]["content"], "original")


if __name__ == "__main__":
    unittest.main()
