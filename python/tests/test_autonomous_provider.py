import asyncio
import json
import sys
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "examples"))
from autonomous_provider import ResponsesClassifier

from loopiter import CallbackContext, LoopiterError


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    def provider(self, **options):
        return ResponsesClassifier(
            model="configured-deployment",
            api_key="synthetic-not-a-key",
            maximum_tokens_per_request=1000,
            maximum_input_bytes=10000,
            maximum_output_tokens=100,
            input_cost_per_token=0.01,
            output_cost_per_token=0.02,
            **{"live": True, **options},
        )

    async def test_explicit_enablement_refusal_usage_and_malformed_output(self):
        with self.assertRaises(LoopiterError):
            self.provider(live=False)
        bodies = [
            {
                "status": "completed",
                "output": [{"type": "message", "content": [{"type": "refusal", "refusal": "no"}]}],
            },
            {"status": "incomplete", "output": []},
            {
                "status": "completed",
                "output": [
                    {"type": "message", "content": [{"type": "output_text", "text": "not JSON"}]}
                ],
            },
            {
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": '{"label":"yes"}'}],
                    }
                ],
            },
        ]
        for body in bodies:
            charged = []

            async def meter(maximum, call, charged=charged):
                charged.append(maximum)
                return (await call())["value"]

            context = CallbackContext("test", asyncio.Event(), meter)
            with patch("autonomous_provider.urllib.request.build_opener") as factory:
                factory.return_value.open.return_value = BytesIO(json.dumps(body).encode())
                with self.assertRaises((LoopiterError, ValueError)):
                    await self.provider().predict(
                        {
                            "safety": "Classify only",
                            "fragment": "test",
                            "text": "input",
                            "labels": ["yes"],
                        },
                        context,
                    )
                self.assertEqual(len(charged), 1)
                self.assertEqual(factory.return_value.open.call_count, 1)

    async def test_structured_output_azure_and_pre_dispatch_cancellation(self):
        body = {
            "status": "completed",
            "output": [
                {"type": "message", "content": [{"type": "output_text", "text": '{"label":"yes"}'}]}
            ],
            "usage": {"input_tokens": 4, "output_tokens": 2},
        }
        usage = []

        async def meter(_, call):
            result = await call()
            usage.append(result["tokens"])
            return result["value"]

        context = CallbackContext("test", asyncio.Event(), meter)
        with patch("autonomous_provider.urllib.request.build_opener") as factory:
            factory.return_value.open.return_value = BytesIO(json.dumps(body).encode())
            p = self.provider(azure_origin="https://example.openai.azure.com")
            inputs = {
                "safety": "Classify only",
                "fragment": "test",
                "text": "input",
                "labels": ["yes"],
            }
            result = await p.predict(inputs, context)
            self.assertEqual(result["cost"], 0.08)
            self.assertEqual(usage, [6])
            request = factory.return_value.open.call_args.args[0]
            self.assertEqual(
                request.full_url, "https://example.openai.azure.com/openai/v1/responses"
            )
            self.assertIsNone(request.get_header("Authorization"))
            payload = json.loads(request.data)
            self.assertFalse(payload["store"])
            self.assertTrue(payload["text"]["format"]["strict"])
            context.cancellation.set()
            with self.assertRaises(LoopiterError):
                await p.predict(inputs, context)
            self.assertEqual(factory.return_value.open.call_count, 1)
