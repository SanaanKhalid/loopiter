"""Real provider SDK with an in-process HTTP transport; no external inference."""

import importlib.util
import json
import unittest

from loopiter import FeedbackLoop, InMemoryStore
from loopiter.integrations.openai import with_loopiter

AVAILABLE = importlib.util.find_spec("openai") is not None


@unittest.skipUnless(AVAILABLE, "Install loopiter[openai] for provider compatibility tests")
class OpenAICompatibilityTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_async_client_generation_and_streaming(self):
        import httpx
        from openai import AsyncOpenAI

        loop = FeedbackLoop(store=InMemoryStore(), namespace="real-sdk")
        requests = []

        async def handler(request):
            params = json.loads(request.content)
            requests.append(params)
            if params.get("stream"):
                chunks = [
                    {
                        "id": "chat-1",
                        "object": "chat.completion.chunk",
                        "model": "fixture",
                        "created": 1,
                        "choices": [
                            {"index": 0, "delta": {"content": "hello"}, "finish_reason": None}
                        ],
                    },
                    {
                        "id": "chat-1",
                        "object": "chat.completion.chunk",
                        "model": "fixture",
                        "created": 1,
                        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                    },
                ]
                return httpx.Response(
                    200,
                    headers={"content-type": "text/event-stream"},
                    text="".join(f"data: {json.dumps(part)}\n\n" for part in chunks)
                    + "data: [DONE]\n\n",
                )
            if request.url.path.endswith("/responses"):
                return httpx.Response(
                    200,
                    json={
                        "id": "resp-1",
                        "object": "response",
                        "created_at": 1,
                        "model": "fixture",
                        "status": "completed",
                        "output": [],
                    },
                )
            return httpx.Response(
                200,
                json={
                    "id": "chat-1",
                    "object": "chat.completion",
                    "model": "fixture",
                    "created": 1,
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": "hello"},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3},
                },
            )

        async with AsyncOpenAI(
            api_key="no-network",
            max_retries=0,
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        ) as base:
            wrapped = with_loopiter(
                base,
                loop=loop,
                context=lambda _: {"artifacts": {"prompt": "v1"}, "guidance": "Released."},
            )
            params = {"model": "fixture", "messages": [{"role": "user", "content": "hello"}]}
            response = await wrapped.chat.completions.create(**params)
            self.assertEqual(response.choices[0].message.content, "hello")
            async with await wrapped.chat.completions.create(**params, stream=True) as stream:
                parts = [part async for part in stream]
            self.assertEqual(len(parts), 2)
            await wrapped.responses.create(model="fixture", input="hello")
        rows = (await loop.list("executions"))["items"]
        self.assertEqual(len(rows), 3)
        self.assertTrue(
            all(row["metadata"]["loopiter_capture"]["status"] == "completed" for row in rows)
        )
        self.assertEqual(len(requests), 3)
        self.assertEqual(params["messages"], [{"role": "user", "content": "hello"}])
