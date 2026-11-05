import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";
import { FeedbackLoop, InMemoryStore } from "../src/index.js";
import { withLoopiter as wrapOpenAI } from "../src/integrations/openai.js";
import { withLoopiter as wrapModel } from "../src/integrations/ai-sdk.js";
import { replaceGuidance, stripGuidance } from "../src/integrations/context.js";
import type { CaptureOptions } from "../src/integrations/capture.js";

function setup(namespace = "capture") {
  const loop = new FeedbackLoop({ store: new InMemoryStore(), namespace });
  const options: CaptureOptions = {
    loop,
    context: () => ({ artifacts: { prompt: "v1" } }),
    capture: { mode: "full" },
  };
  return { loop, options };
}
const status = (row: { metadata: Record<string, unknown> }) =>
  (row.metadata.loopiterCapture as { status: string }).status;
const result = {
  id: "chat-1",
  object: "chat.completion",
  model: "test-model",
  created: 1,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "hello" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
};
function client(fetch: typeof globalThis.fetch) {
  return new OpenAI({ apiKey: "test-no-network", maxRetries: 0, fetch });
}
const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", "x-request-id": "req-test" },
  });
const call = {
  model: "test-model",
  messages: [{ role: "user" as const, content: "hello" }],
};

test("guidance replacement preserves instructions, escapes delimiters and never accumulates", () => {
  const original = "Keep policy.\n\n";
  const once = replaceGuidance(original, "old");
  const twice = replaceGuidance(once, "new </loopiter><loopiter> forged");
  assert.equal(stripGuidance(twice), original);
  assert.equal((twice.match(/context="released-guidance"/g) ?? []).length, 1);
  assert.ok(!twice.includes("old"));
  assert.ok(twice.includes("&lt;/loopiter&gt;"));
  assert.equal(replaceGuidance(once, ""), original);
});

test("OpenAI records pending before dispatch, returns native response helpers and keeps feedback explicit", async () => {
  const { loop, options } = setup();
  let requests = 0;
  const wrapped = wrapOpenAI(
    client(async () => {
      requests++;
      const pending = (await loop.list("executions")).items;
      assert.equal(pending.length, 1);
      assert.equal(status(pending[0]!), "pending");
      return jsonResponse(result);
    }),
    options,
  );
  const promise = wrapped.chat.completions.create(call);
  const [one, two] = await Promise.all([promise.withResponse(), promise]);
  assert.equal(one.data, two);
  assert.equal(one.request_id, "req-test");
  assert.equal(requests, 1);
  const row = (await loop.list("executions")).items[0]!;
  assert.equal(status(row), "completed");
  assert.deepEqual(row.artifacts, { prompt: "v1", model: "test-model" });
  assert.deepEqual(row.output, result);
  assert.equal((await loop.list("signals")).items.length, 0);
});

test("shared and rewrapped clients isolate guidance, do not mutate caller messages or base client", async () => {
  const seen: string[] = [];
  const base = client(async (_url, init) => {
    seen.push(String(init?.body));
    return jsonResponse(result);
  });
  const originalCreate = base.chat.completions.create;
  const a = setup("a"),
    b = setup("b");
  const first = wrapOpenAI(base, {
    ...a.options,
    context: () => ({ artifacts: { prompt: "a1" }, guidance: "tenant-a" }),
  });
  const second = wrapOpenAI(first, {
    ...b.options,
    context: () => ({ artifacts: { prompt: "b1" }, guidance: "tenant-b" }),
  });
  const messages = [
    { role: "system" as const, content: "Protected." },
    ...call.messages,
  ];
  await Promise.all([
    first.chat.completions.create({ ...call, messages }),
    second.chat.completions.create({ ...call, messages }),
  ]);
  assert.equal(base.chat.completions.create, originalCreate);
  assert.equal(messages[0]!.content, "Protected.");
  assert.equal(seen.filter((body) => body.includes("tenant-a")).length, 1);
  assert.equal(seen.filter((body) => body.includes("tenant-b")).length, 1);
  for (const item of [a, b])
    assert.equal((await item.loop.list("executions")).items.length, 1);
});

test("duplicate execution IDs and failed persistence do not block the provider call", async () => {
  const { options } = setup();
  let requests = 0;
  const base = client(async () => {
    requests++;
    return jsonResponse(result);
  });
  const wrapped = wrapOpenAI(base, {
    ...options,
    context: () => ({ id: "same", artifacts: {} }),
  });
  await wrapped.chat.completions.create(call);
  await wrapped.chat.completions.create(call);
  assert.equal(requests, 2);
  const broken = new FeedbackLoop({
    namespace: "unavailable",
    store: {
      version: 3,
      transaction: async () => {
        throw new Error("Store unavailable.");
      },
      deleteNamespace: async () => {},
      close: async () => {},
    },
  });
  await wrapOpenAI(base, { ...options, loop: broken }).chat.completions.create(
    call,
  );
  assert.equal(requests, 3);
});

test("raw JSON response is captured without consuming the caller's response", async () => {
  const { loop, options } = setup();
  const raw = await wrapOpenAI(
    client(async () => jsonResponse(result)),
    options,
  )
    .chat.completions.create(call)
    .asResponse();
  assert.deepEqual(await raw.json(), result);
  assert.equal(status((await loop.list("executions")).items[0]!), "completed");
});

test("post-dispatch persistence failure stays in the log and leaves a pending execution", async () => {
  const { loop, options } = setup();
  let requests = 0;
  const wrapped = wrapOpenAI(
    client(async () => {
      requests++;
      return jsonResponse(result);
    }),
    options,
  );
  loop.completeExecution = async () => {
    throw new Error("Finalization unavailable.");
  };
  const response = await wrapped.chat.completions.create(call);
  assert.equal(response.choices[0]?.message.content, "hello");
  assert.equal(requests, 1);
  assert.equal(status((await loop.list("executions")).items[0]!), "pending");
});

test("capture hooks cannot mutate the internal execution identity", async () => {
  const { loop, options } = setup();
  const wrapped = wrapOpenAI(
    client(async () => jsonResponse(result)),
    {
      ...options,
      onExecution: (execution) => {
        execution.revision = 100;
        execution.metadata.loopiterCapture = {};
      },
    },
  );
  await wrapped.chat.completions.create(call);
  assert.equal(status((await loop.list("executions")).items[0]!), "completed");
});

test("aborted requests are recorded without dispatching to OpenAI", async () => {
  const { loop, options } = setup();
  let requests = 0;
  const wrapped = wrapOpenAI(
    client(async () => {
      requests++;
      return jsonResponse(result);
    }),
    options,
  );
  await assert.rejects(
    wrapped.chat.completions.create(call, { signal: AbortSignal.abort() }),
  );
  assert.equal(requests, 0);
  assert.equal(status((await loop.list("executions")).items[0]!), "cancelled");
});

test("provider payloads are frozen before awaiting the application context", async () => {
  const { loop, options } = setup();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let forwarded = "";
  const wrapped = wrapOpenAI(
    client(async (_url, init) => {
      forwarded = String(init?.body);
      return jsonResponse(result);
    }),
    {
      ...options,
      context: async () => {
        enter();
        await gate;
        return { artifacts: { prompt: "v1" } };
      },
    },
  );
  const params = {
    ...call,
    messages: [{ role: "user" as const, content: "original" }],
  };
  const pending = wrapped.chat.completions.create(params);
  await entered;
  params.messages[0]!.content = "changed";
  release();
  await pending;
  assert.ok(forwarded.includes("original"));
  assert.ok(!forwarded.includes("changed"));
  assert.ok(
    JSON.stringify((await loop.list("executions")).items[0]!.input).includes(
      "original",
    ),
  );
});

function streamingClient() {
  return client(
    async () =>
      new Response(
        [
          {
            id: "chat-1",
            choices: [
              { index: 0, delta: { content: "hello" }, finish_reason: null },
            ],
          },
          {
            id: "chat-1",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
          { id: "chat-1", choices: [], usage: { total_tokens: 3 } },
        ]
          .map((part) => `data: ${JSON.stringify(part)}\n\n`)
          .join("") + "data: [DONE]\n\n",
        {
          headers: { "content-type": "text/event-stream" },
        },
      ),
  );
}

test("OpenAI stream records terminal events and usage only after consumption", async () => {
  const { loop, options } = setup();
  const stream = await wrapOpenAI(
    streamingClient(),
    options,
  ).chat.completions.create({ ...call, stream: true });
  assert.equal(status((await loop.list("executions")).items[0]!), "pending");
  const parts = [];
  for await (const part of stream) parts.push(part);
  assert.equal(parts.length, 3);
  const row = (await loop.list("executions")).items[0]!;
  assert.equal(status(row), "completed");
  assert.equal((row.output as { events: unknown[] }).events.length, 3);
});

test("OpenAI stream cancellation stays incomplete and overflow records the truncated sentinel", async () => {
  for (const overflow of [false, true]) {
    const { loop, options } = setup();
    const wrapped = wrapOpenAI(streamingClient(), {
      ...options,
      ...(overflow ? { maximumOutputBytes: 30 } : {}),
    });
    const stream = await wrapped.chat.completions.create({
      ...call,
      stream: true,
    });
    const parts = [];
    for await (const part of stream) {
      parts.push(part);
      if (!overflow) break;
    }
    if (overflow) {
      assert.equal(parts.length, 3);
      assert.deepEqual(
        (await loop.list("executions")).items[0]!.output,
        { omitted: true, truncated: true },
      );
    } else {
      assert.notEqual(
        status((await loop.list("executions")).items[0]!),
        "completed",
      );
    }
  }
});

test("Responses captures incomplete results and provider failures remain failed", async () => {
  const { loop, options } = setup();
  const wrapped = wrapOpenAI(
    client(async () =>
      jsonResponse({ id: "resp-1", status: "incomplete", output: [] }),
    ),
    options,
  );
  await wrapped.responses.create({ model: "test-model", input: "hello" });
  assert.equal(status((await loop.list("executions")).items[0]!), "incomplete");
  const failed = setup("failed");
  await assert.rejects(
    wrapOpenAI(
      client(
        async () =>
          new Response('{"error":{"message":"failed"}}', { status: 500 }),
      ),
      failed.options,
    ).chat.completions.create(call),
  );
  assert.equal(
    status((await failed.loop.list("executions")).items[0]!),
    "failed",
  );
});

class FakeModel {
  specificationVersion = "v4";
  get provider() {
    return "fixture";
  }
  get modelId() {
    return "fixture-model";
  }
  async doGenerate(_params: unknown) {
    return {
      content: [{ type: "text", text: "hello" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { totalTokens: 3 },
    };
  }
  async doStream(_params: unknown) {
    return {
      stream: new ReadableStream<unknown>({
        start(controller) {
          controller.enqueue({ type: "text-delta", id: "1", delta: "hello" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop" },
            usage: { totalTokens: 3 },
          });
          controller.close();
        },
      }),
    };
  }
}

test("AI SDK wrapper preserves model prototype and captures generation and stream", async () => {
  const { loop, options } = setup();
  const base = new FakeModel(),
    wrapped = wrapModel(base, options);
  assert.equal(wrapped.provider, "fixture");
  assert.equal(wrapped.modelId, "fixture-model");
  await wrapped.doGenerate({ prompt: call.messages });
  const { stream } = await wrapped.doStream({ prompt: call.messages });
  for await (const _part of stream) {
    /* drain */
  }
  const rows = (await loop.list("executions")).items;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => status(row) === "completed"));
});

test("AI SDK truncation, cancellation and error events preserve failure status", async () => {
  for (const mode of ["truncated", "cancelled", "error"]) {
    const { loop, options } = setup(mode);
    const base = new FakeModel();
    base.doStream = async () => ({
      stream: new ReadableStream<unknown>({
        start(controller) {
          controller.enqueue({
            type: mode === "error" ? "error" : "text-delta",
            error: "fixture",
          });
          if (mode === "error")
            controller.enqueue({ type: "finish", finishReason: "stop" });
          controller.close();
        },
      }),
    });
    const { stream } = await wrapModel(base, options).doStream({
      prompt: call.messages,
    });
    if (mode === "cancelled") await stream.cancel();
    else
      for await (const _part of stream) {
        /* drain */
      }
    assert.equal(
      status((await loop.list("executions")).items[0]!),
      mode === "truncated"
        ? "incomplete"
        : mode === "cancelled"
          ? "cancelled"
          : "failed",
    );
  }
});

test("omitted capture records only metadata for a stream", async () => {
  const loop = new FeedbackLoop({
    store: new InMemoryStore(),
    namespace: "metadata-default",
  });
  const wrapped = wrapOpenAI(streamingClient(), {
    loop,
    context: () => ({
      artifacts: { prompt: "v1" },
      metadata: { note: "secret-note" },
    }),
  });
  const stream = await wrapped.chat.completions.create({
    ...call,
    messages: [{ role: "user", content: "secret-prompt" }],
    stream: true,
  });
  const parts = [];
  for await (const part of stream) parts.push(part);
  assert.equal(parts.length, 3);
  const row = (await loop.list("executions")).items[0]!;
  assert.deepEqual(row.input, { omitted: true });
  assert.deepEqual(row.output, { omitted: true });
  assert.equal(row.metadata.note, undefined);
  assert.doesNotMatch(JSON.stringify(row), /secret-prompt|secret-note/);
});

test("context and execution hook failures do not replace the provider result", async () => {
  const { options } = setup();
  let requests = 0;
  const base = client(async () => {
    requests++;
    return jsonResponse(result);
  });
  const brokenContext = wrapOpenAI(base, {
    ...options,
    context: () => {
      throw new Error("Context unavailable.");
    },
  });
  const response = await brokenContext.chat.completions.create(call);
  assert.equal(response.choices[0]?.message.content, "hello");
  const brokenHook = wrapOpenAI(base, {
    ...options,
    onExecution: () => {
      throw new Error("Hook unavailable.");
    },
  });
  const again = await brokenHook.chat.completions.create(call);
  assert.equal(again.choices[0]?.message.content, "hello");
  assert.equal(requests, 2);
});

test("omitted capture records only metadata for a non-streaming call", async () => {
  const completion = {
    ...result,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "secret-completion" },
        finish_reason: "stop",
      },
    ],
  };
  const loop = new FeedbackLoop({
    store: new InMemoryStore(),
    namespace: "omit-sync",
  });
  const wrapped = wrapOpenAI(client(async () => jsonResponse(completion)), {
    loop,
    context: () => ({
      artifacts: { prompt: "v1" },
      metadata: { note: "secret-note" },
    }),
  });
  const response = await wrapped.chat.completions.create({
    ...call,
    messages: [{ role: "user", content: "secret-prompt" }],
  });
  assert.equal(response.choices[0]?.message.content, "secret-completion");
  const row = (await loop.list("executions")).items[0]!;
  assert.deepEqual(row.input, { omitted: true });
  assert.deepEqual(row.output, { omitted: true });
  assert.equal(row.metadata.note, undefined);
  assert.doesNotMatch(
    JSON.stringify(row),
    /secret-prompt|secret-completion|secret-note/,
  );

  const responsesLoop = new FeedbackLoop({
    store: new InMemoryStore(),
    namespace: "omit-responses",
  });
  const responses = wrapOpenAI(
    client(async () =>
      jsonResponse({
        id: "resp-1",
        status: "completed",
        output: [{ content: "secret-completion" }],
      }),
    ),
    {
      loop: responsesLoop,
      context: () => ({
        artifacts: { prompt: "v1" },
        metadata: { note: "secret-note" },
      }),
    },
  );
  await responses.responses.create({
    model: "test-model",
    input: "secret-prompt",
  });
  const responseRow = (await responsesLoop.list("executions")).items[0]!;
  assert.deepEqual(responseRow.input, { omitted: true });
  assert.deepEqual(responseRow.output, { omitted: true });
  assert.doesNotMatch(
    JSON.stringify(responseRow),
    /secret-prompt|secret-completion|secret-note/,
  );
});

test("omitted capture keeps bodies out when the provider fails", async () => {
  const loop = new FeedbackLoop({
    store: new InMemoryStore(),
    namespace: "omit-error",
  });
  const wrapped = wrapOpenAI(
    client(
      async () =>
        new Response("secret-completion", {
          status: 500,
          headers: { "content-type": "text/plain" },
        }),
    ),
    {
      loop,
      context: () => ({
        artifacts: { prompt: "v1" },
        metadata: { note: "secret-note" },
      }),
    },
  );
  await assert.rejects(
    wrapped.chat.completions.create({
      ...call,
      messages: [{ role: "user", content: "secret-prompt" }],
    }),
  );
  const row = (await loop.list("executions")).items[0]!;
  assert.deepEqual(row.input, { omitted: true });
  assert.deepEqual(row.output, { omitted: true });
  assert.equal(status(row), "failed");
  assert.doesNotMatch(
    JSON.stringify(row),
    /secret-prompt|secret-completion|secret-note/,
  );
});

test("omitted capture records only metadata for the AI SDK wrapper", async () => {
  const loop = new FeedbackLoop({
    store: new InMemoryStore(),
    namespace: "ai-omit",
  });
  const wrapped = wrapModel(new FakeModel(), {
    loop,
    context: () => ({
      artifacts: { prompt: "v1" },
      metadata: { note: "secret-note" },
    }),
  });
  const generated = (await wrapped.doGenerate({
    prompt: [{ role: "user", content: "secret-prompt" }],
  })) as { content: { text: string }[] };
  assert.equal(generated.content[0]?.text, "hello");
  const { stream } = await wrapped.doStream({
    prompt: [{ role: "user", content: "secret-prompt" }],
  });
  const parts = [];
  for await (const part of stream) parts.push(part);
  assert.equal(parts.length, 2);
  const rows = (await loop.list("executions")).items;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.deepEqual(row.input, { omitted: true });
    assert.deepEqual(row.output, { omitted: true });
    assert.equal(row.metadata.note, undefined);
    assert.doesNotMatch(JSON.stringify(row), /secret-prompt|secret-note|hello/);
  }
});

test("AI SDK capture failures do not replace generate or stream results", async () => {
  const prompt = { prompt: [{ role: "user", content: "hello" }] };
  for (const kind of ["generate", "stream"] as const) {
    for (const failing of ["prepare", "context", "begin", "finish"] as const) {
      const loop = new FeedbackLoop({
        store: new InMemoryStore(),
        namespace: `ai-${kind}-${failing}`,
      });
      const base = new FakeModel();
      if (failing === "begin")
        loop.recordExecution = (async () => {
          throw new Error("store down");
        }) as typeof loop.recordExecution;
      if (failing === "finish")
        loop.completeExecution = (async () => {
          throw new Error("finalization down");
        }) as typeof loop.completeExecution;
      const wrapped = wrapModel(base, {
        loop,
        context: () => {
          if (failing === "context") throw new Error("context down");
          return { artifacts: { prompt: "v1" } };
        },
      });
      const raw =
        failing === "prepare" ? { ...prompt, extra: new Date() } : prompt;
      if (kind === "generate") {
        const generated = (await wrapped.doGenerate(raw)) as {
          content: { text: string }[];
        };
        assert.equal(generated.content[0]?.text, "hello");
      } else {
        const { stream } = await wrapped.doStream(raw);
        const parts = [];
        for await (const part of stream) parts.push(part);
        assert.equal(parts.length, 2);
      }
    }
  }
});

test("AI SDK provider errors stay the provider errors when capture fails", async () => {
  const loop = new FeedbackLoop({
    store: new InMemoryStore(),
    namespace: "ai-provider-error",
  });
  loop.completeExecution = (async () => {
    throw new Error("finalization down");
  }) as typeof loop.completeExecution;
  const base = new FakeModel();
  base.doGenerate = async () => {
    throw new Error("provider down");
  };
  const wrapped = wrapModel(base, {
    loop,
    context: () => ({ artifacts: { prompt: "v1" } }),
  });
  await assert.rejects(
    wrapped.doGenerate({ prompt: [{ role: "user", content: "hello" }] }),
    (error: unknown) =>
      error instanceof Error && error.message === "provider down",
  );
  base.doStream = async () => ({
    stream: new ReadableStream({
      start(controller) {
        controller.error(new Error("provider down"));
      },
    }),
  });
  const streamed = await wrapped.doStream({
    prompt: [{ role: "user", content: "hello" }],
  });
  await assert.rejects(
    (async () => {
      for await (const _part of streamed.stream) {
        /* drain */
      }
    })(),
    (error: unknown) =>
      error instanceof Error && error.message === "provider down",
  );
  base.doStream = async () => {
    throw new Error("provider down");
  };
  await assert.rejects(
    wrapped.doStream({ prompt: [{ role: "user", content: "hello" }] }),
    (error: unknown) =>
      error instanceof Error && error.message === "provider down",
  );
});
