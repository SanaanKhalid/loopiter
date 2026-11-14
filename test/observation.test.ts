import test from "node:test";
import assert from "node:assert/strict";
import { FeedbackLoop, InMemoryStore, type JsonObject } from "../src/index.js";
import { createObserver, capturePayload } from "../src/integrations/observe.js";
import { createLoopiterSpanExporter, spanExecutionId, type ReadableSpan } from "../src/integrations/otel.js";
import { CaptureSession } from "../src/integrations/capture.js";

const setup = () => new FeedbackLoop({ store: new InMemoryStore(), namespace: "observe-tests" });
const state = (r: {metadata:JsonObject}) => r.metadata.loopiterCapture as JsonObject;

test("capture redacts before bounding, preserves application values, and explicitly marks incomplete data", () => {
  const raw = { authorization:"Bearer top-secret", messages:[{content:"password=private https://alice:password@example.test sk-1234567890123456"}], apiKey:"private", text:"safe" };
  const redacted = capturePayload(raw,{mode:"redacted"});
  assert.doesNotMatch(JSON.stringify(redacted.value), /top-secret|private|alice|1234567890123456/);
  assert.equal(raw.apiKey,"private");
  assert.equal(redacted.complete,false);
  const long = capturePayload({apiKey:"secret".repeat(2000)},{mode:"redacted",maximumBytes:128});
  assert.equal(long.truncated,false,"Redaction precedes bounding");
  assert.deepEqual(capturePayload({text:"x".repeat(1000)},{mode:"redacted",maximumBytes:128}).value,{omitted:true,truncated:true,bytes:1011});
  assert.deepEqual(capturePayload(raw,{mode:"metadata-only"}).value,{omitted:true});
  assert.equal(capturePayload(raw,{mode:"full"}).complete,true);
  assert.throws(()=>capturePayload(raw,{mode:"redacted",maximumBytes:NaN}));
});

test("observer retains lineage, defaults to no content, preserves return identity and never replays a durable ID", async () => {
  const loop=setup(), observer=createObserver({loop});
  const result={answer:"private"}; let calls=0;
  const run=()=>observer.observe("support.answer",()=>{calls++;return result;},{input:{secret:"private"},context:{id:"first",traceId:"trace",releaseId:"release",learningContext:{tenantId:"acme"}}});
  assert.equal(await run(),result);
  const saved=(await loop.getExecution("first"))!;
  assert.deepEqual(saved.input,{omitted:true}); assert.deepEqual(saved.output,{omitted:true});
  assert.deepEqual(saved.metadata.learningContext,{tenantId:"acme"});
  assert.equal(saved.artifacts.prompt,"release");assert.equal(state(saved).status,"completed");
  assert.equal(state(saved).replayEligible,false);
  await assert.rejects(run(),/already exists/);assert.equal(calls,1);
});

test("stream observation is lazy, propagates cancellation, records failure, and never buffers payloads", async () => {
  const loop=setup(), observer=createObserver({loop,capture:{mode:"full"}});let produced=0,closed=false;
  async function* stream(){try{for(let n=0;n<100;n++){produced++;yield {secret:"x".repeat(100000)};}}finally{closed=true;}}
  const result=await observer.observe("stream",stream,{context:{id:"stream"}});
  assert.equal(produced,0);
  for await(const chunk of result){assert.equal(chunk.secret.length,100000);break;}
  assert.equal(produced,1);assert.equal(closed,true);
  assert.equal(state((await loop.getExecution("stream"))!).status,"cancelled");
  const problem=new Error("original");
  const failure=await observer.observe("failing",async function*(){yield 1;throw problem;},{context:{id:"failure"}});
  await assert.rejects(async()=>{for await(const _ of failure){}}, e=>e===problem);
  assert.equal(state((await loop.getExecution("failure"))!).status,"failed");
});

test("bounded capture does not wait on a stalled store, drops a full queue, counts write failures, and stops flushing at the shutdown timeout", async () => {
  const hang = () => new Promise(() => {});
  const stalled = {
    getExecution: async () => undefined,
    recordExecution: hang,
    completeExecution: hang,
  } as unknown as FeedbackLoop;
  const slow = createObserver({
    loop: stalled,
    bounded: { queueLimit: 4, writeTimeoutMs: 60, shutdownTimeoutMs: 1_000 },
  });
  const started = Date.now();
  assert.equal(await slow.observe("slow", () => "served"), "served");
  assert.ok(Date.now() - started < 50, "request waited on the store");
  await slow.shutdown(20);
  const tight = createObserver({
    loop: stalled,
    bounded: { queueLimit: 2, writeTimeoutMs: 60 },
  });
  assert.throws(
    () => createObserver({ loop: stalled, bounded: { queueLimit: 1, writeTimeoutMs: 60 } }),
    /at least 2/,
  );
  assert.equal(await tight.observe("first", () => 1), 1);
  assert.equal(await tight.observe("second", () => 2), 2);
  assert.equal(tight.stats().dropped, 1);
  await tight.shutdown(20);
  let failures = 0;
  const broken = {
    getExecution: async () => undefined,
    recordExecution: async () => { throw new Error("storage down"); },
    completeExecution: async () => { throw new Error("storage down"); },
  } as unknown as FeedbackLoop;
  const failing = createObserver({
    loop: broken,
    onError: () => { failures += 1; },
    bounded: { queueLimit: 4, writeTimeoutMs: 200 },
  });
  assert.equal(await failing.observe("broken", () => 7), 7);
  await failing.forceFlush(200);
  assert.equal(failing.stats().failed, 1);
  assert.equal(failures, 1);
  await failing.shutdown(20);
  const stopping = createObserver({
    loop: stalled,
    bounded: { queueLimit: 4, writeTimeoutMs: 60, shutdownTimeoutMs: 40 },
  });
  await stopping.observe("hold", () => true);
  const flushed = Date.now();
  await stopping.shutdown();
  assert.ok(Date.now() - flushed < 120, "shutdown flush ignored its timeout");
  assert.ok(stopping.stats().dropped >= 1);
  assert.throws(
    () => createObserver({ loop: stalled, failureMode: "closed", bounded: { queueLimit: 2, writeTimeoutMs: 20 } }),
    /cannot be combined/,
  );
});

test("bounded capture records a completed row, holds a timed-out slot, ignores the late result, and does not replay a durable id", async () => {
  const loop = setup();
  const saved = createObserver({
    loop,
    bounded: { queueLimit: 4, writeTimeoutMs: 500 },
  });
  assert.equal(await saved.observe("saved", () => "yes", { context: { id: "saved-row" } }), "yes");
  await saved.forceFlush(200);
  assert.equal(state((await loop.getExecution("saved-row"))!).status, "completed");
  await saved.shutdown(20);
  let calls = 0;
  let release: (row: { id: string; revision: number; metadata: JsonObject }) => void = () => {};
  const completes: string[] = [];
  const gated = {
    getExecution: async () => undefined,
    recordExecution: (input: { id: string; metadata: JsonObject }) => {
      calls += 1;
      return new Promise((resolve) => {
        release = resolve;
      }).then(() => ({
        id: input.id, revision: 1,
        metadata: { loopiterCapture: { attemptId: (input.metadata.loopiterCapture as JsonObject).attemptId } },
      }));
    },
    completeExecution: async (_id: string, patch: { metadata: JsonObject }) => {
      completes.push(String((patch.metadata.loopiterCapture as JsonObject).status));
    },
  } as unknown as FeedbackLoop;
  const timed = createObserver({
    loop: gated,
    bounded: { queueLimit: 2, writeTimeoutMs: 30 },
  });
  assert.equal(await timed.observe("late", () => "served"), "served");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(timed.stats().failed, 1);
  assert.equal(calls, 1);
  assert.ok(timed.stats().backlog >= 1);
  assert.equal(await timed.observe("next", () => "nope"), "nope");
  assert.equal(calls, 1);
  assert.equal(timed.stats().dropped, 1);
  release({ id: "late-row", revision: 1, metadata: { loopiterCapture: { attemptId: "ignored" } } });
  await timed.forceFlush(200);
  assert.deepEqual(completes, ["failed"]);
  assert.equal(timed.stats().failed, 1);
  await timed.shutdown(20);
  await loop.recordExecution({ id: "kept", kind: "workflow", input: { marker: "original" } });
  const before = (await loop.getExecution("kept"))!;
  let ran = 0;
  const durable = createObserver({
    loop,
    bounded: { queueLimit: 4, writeTimeoutMs: 200 },
  });
  assert.equal(await durable.observe("again", () => { ran += 1; return 3; }, { context: { id: "kept" } }), 3);
  assert.equal(ran, 1);
  await durable.forceFlush(200);
  assert.equal(durable.stats().failed, 1);
  assert.equal((await loop.getExecution("kept"))!.revision, before.revision);
  await durable.shutdown(20);
  const partial = {
    getExecution: async () => undefined,
    recordExecution: async (input: { id: string; metadata: JsonObject }) => ({
      id: input.id, revision: 1,
      metadata: { loopiterCapture: { attemptId: (input.metadata.loopiterCapture as JsonObject).attemptId } },
    }),
    completeExecution: async () => { throw new Error("complete down"); },
  } as unknown as FeedbackLoop;
  let completeNotes = 0;
  const completer = createObserver({
    loop: partial,
    onError: () => { completeNotes += 1; },
    bounded: { queueLimit: 4, writeTimeoutMs: 200 },
  });
  assert.equal(await completer.observe("partial", () => 9), 9);
  await completer.forceFlush(200);
  assert.equal(completer.stats().failed, 1);
  assert.equal(completeNotes, 1);
  await completer.shutdown(20);
});

test("shutdown ignores a hung record and does not finish after abandon", async () => {
  let releaseRecord: () => void = () => {};
  const writes: string[] = [];
  const hung = {
    getExecution: async () => undefined,
    recordExecution: () => new Promise<void>((resolve) => {
      releaseRecord = () => resolve();
    }).then(() => {
      writes.push("record");
      return { id: "hung", revision: 1, metadata: { loopiterCapture: { attemptId: "x", truncated: false } } };
    }),
    completeExecution: async () => { writes.push("complete"); },
  } as unknown as FeedbackLoop;
  const mid = createObserver({
    loop: hung,
    bounded: { queueLimit: 4, writeTimeoutMs: 5_000, shutdownTimeoutMs: 30 },
  });
  const ran = mid.observe("mid", () => "ran");
  await mid.shutdown();
  assert.ok(mid.stats().backlog >= 0);
  releaseRecord();
  assert.equal(await ran, "ran");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(writes, ["record"]);
  assert.ok(mid.stats().backlog >= 0);

  let releaseOp: (value: string) => void = () => {};
  const finishes: string[] = [];
  const pausing = createObserver({
    loop: {
      getExecution: async () => undefined,
      recordExecution: async (input: { id: string; metadata: JsonObject }) => ({
        id: input.id, revision: 1,
        metadata: { loopiterCapture: { attemptId: (input.metadata.loopiterCapture as JsonObject).attemptId, truncated: false } },
      }),
      completeExecution: async () => { finishes.push("complete"); },
    } as unknown as FeedbackLoop,
    bounded: { queueLimit: 4, writeTimeoutMs: 5_000, shutdownTimeoutMs: 40 },
  });
  const op = pausing.observe("op", () => new Promise<string>((resolve) => { releaseOp = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await pausing.shutdown();
  releaseOp("done");
  assert.equal(await op, "done");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(finishes, []);
  assert.ok(pausing.stats().backlog >= 0);

  const streamWrites: string[] = [];
  const streaming = createObserver({
    loop: {
      getExecution: async () => undefined,
      recordExecution: async (input: { id: string; metadata: JsonObject }) => ({
        id: input.id, revision: 1,
        metadata: { loopiterCapture: { attemptId: (input.metadata.loopiterCapture as JsonObject).attemptId, truncated: false } },
      }),
      completeExecution: async () => { streamWrites.push("complete"); },
    } as unknown as FeedbackLoop,
    bounded: { queueLimit: 4, writeTimeoutMs: 5_000, shutdownTimeoutMs: 30 },
  });
  async function* pending() { yield 1; }
  const wrapped = await streaming.observe("stream", pending);
  await streaming.shutdown();
  for await (const _chunk of wrapped) { /* consume after shutdown */ }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(streamWrites, []);
  assert.ok(streaming.stats().backlog >= 0);
});

test("shutdown counts a running operation and an unconsumed stream once", async () => {
  const loop = setup();
  const notes: unknown[] = [];
  const running = createObserver({
    loop,
    onError: (error) => notes.push(error),
    bounded: { queueLimit: 10, writeTimeoutMs: 100, shutdownTimeoutMs: 40 },
  });
  let release: (value: string) => void = () => {};
  const operation = running.observe(
    "long",
    () => new Promise<string>((resolve) => { release = resolve; }),
    { context: { id: "s1" } },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  await running.shutdown(40);
  assert.equal(running.stats().dropped, 1);
  assert.equal(running.stats().failed, 0);
  assert.equal(running.stats().backlog, 0);
  assert.equal(notes.length, 1);
  release("done");
  assert.equal(await operation, "done");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(running.stats().dropped, 1);
  assert.equal(notes.length, 1);
  assert.equal(state((await loop.getExecution("s1"))!).status, "pending");

  const streamNotes: unknown[] = [];
  const streaming = createObserver({
    loop,
    onError: (error) => streamNotes.push(error),
    bounded: { queueLimit: 10, writeTimeoutMs: 100, shutdownTimeoutMs: 40 },
  });
  async function* pending() { yield 1; }
  const wrapped = await streaming.observe("stream", pending, { context: { id: "s3" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await streaming.shutdown(40);
  assert.equal(streaming.stats().dropped, 1);
  assert.equal(streaming.stats().failed, 0);
  assert.equal(streaming.stats().backlog, 0);
  assert.equal(streamNotes.length, 1);
  for await (const _chunk of wrapped) { /* consume after shutdown */ }
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(streaming.stats().dropped, 1);
  assert.equal(streamNotes.length, 1);
  assert.equal(state((await loop.getExecution("s3"))!).status, "pending");
});

test("shutdown drains admitted writes, and an open flush does not free a hung write or a reservation", async () => {
  const loop = setup();
  const drained = createObserver({
    loop,
    bounded: { queueLimit: 4, writeTimeoutMs: 500, shutdownTimeoutMs: 200 },
  });
  assert.equal(await drained.observe("saved", () => "ok", { context: { id: "shutdown-row" } }), "ok");
  await drained.shutdown();
  assert.equal(state((await loop.getExecution("shutdown-row"))!).status, "completed");
  assert.equal(drained.stats().dropped, 0);
  assert.equal(drained.stats().failed, 0);
  let notes = 0;
  let calls = 0;
  const hung = {
    getExecution: async () => undefined,
    recordExecution: () => {
      calls += 1;
      return new Promise(() => {});
    },
    completeExecution: () => new Promise(() => {}),
  } as unknown as FeedbackLoop;
  const stall = createObserver({
    loop: hung,
    onError: () => { notes += 1; },
    bounded: { queueLimit: 4, writeTimeoutMs: 5_000, shutdownTimeoutMs: 40 },
  });
  await stall.observe("hung", () => 1);
  await stall.shutdown();
  assert.ok(stall.stats().dropped + stall.stats().failed >= 1);
  assert.ok(notes >= 1);
  assert.equal(calls, 1);
  let release: (value: string) => void = () => {};
  const open = createObserver({
    loop,
    bounded: { queueLimit: 4, writeTimeoutMs: 500, shutdownTimeoutMs: 30 },
  });
  const pending = open.observe("hold", () => new Promise<string>((resolve) => { release = resolve; }), {
    context: { id: "held-row" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const droppedBefore = open.stats().dropped;
  await open.forceFlush(30);
  assert.equal(open.stats().dropped, droppedBefore);
  assert.ok(open.stats().backlog >= 1);
  release("later");
  assert.equal(await pending, "later");
  await open.forceFlush(200);
  assert.equal(state((await loop.getExecution("held-row"))!).status, "completed");
  await open.shutdown(20);
  const repeated = createObserver({
    loop: hung,
    bounded: { queueLimit: 4, writeTimeoutMs: 5_000, shutdownTimeoutMs: 15 },
  });
  await repeated.observe("once", () => true);
  for (let i = 0; i < 5; i++) await repeated.forceFlush(15);
  assert.equal(calls, 2);
  await repeated.shutdown(15);
  let releaseOverlap: (value: string) => void = () => {};
  const overlap = createObserver({
    loop,
    bounded: { queueLimit: 4, writeTimeoutMs: 500, shutdownTimeoutMs: 40 },
  });
  const running = overlap.observe(
    "overlap",
    () => new Promise<string>((resolve) => { releaseOverlap = resolve; }),
    { context: { id: "overlap-row" } },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const shortFlush = overlap.forceFlush(40);
  const drainedShutdown = overlap.shutdown(400);
  await new Promise((resolve) => setTimeout(resolve, 80));
  releaseOverlap("done");
  assert.equal(await running, "done");
  await shortFlush;
  await drainedShutdown;
  assert.equal(state((await loop.getExecution("overlap-row"))!).status, "completed");
  assert.equal(overlap.stats().dropped, 0);
});

test("telemetry outage does not retry or replace application errors; strict capture fails before the call", async () => {
  const loop=setup(); loop.recordExecution=async()=>{throw Error("storage down");};let calls=0,errors=0;
  const observer=createObserver({loop,onError:()=>{errors++;}});
  assert.equal(await observer.observe("answer",()=>{calls++;return 42;}),42);
  const problem=new Error("app failed");
  await assert.rejects(observer.observe("answer",()=>{calls++;throw problem;}),e=>e===problem);
  assert.equal(calls,2);assert.equal(errors,2);
  await assert.rejects(createObserver({loop,failureMode:"closed"}).observe("answer",()=>{calls++;return 42;}),/storage down/);
  assert.equal(calls,2);
});

test("provider privacy mode removes payloads and arbitrary metadata while preserving actual calls", async () => {
  const loop=setup();
  const session=await CaptureSession.begin({loop,context:()=>({artifacts:{}}),capture:{mode:"metadata-only"}},
    {id:"provider",artifacts:{model:"pinned"},metadata:{private:"do not retain"}},
    {integration:"custom",model:"model-version",input:{secret:"input"}});
  session.append({secret:"chunk"});await session.finish("completed",{secret:"output"});
  const row=(await loop.getExecution("provider"))!;
  assert.deepEqual(row.input,{omitted:true});assert.deepEqual(row.output,{omitted:true});
  assert.equal(row.metadata.private,undefined);assert.equal(state(row).replayEligible,false);
});

test("OTel exporter deduplicates identities, keeps model versions, omits arbitrary data, and does not infer success", async () => {
  const loop=setup();
  const span:ReadableSpan={name:"private customer",spanContext:()=>({traceId:"a".repeat(32),spanId:"b".repeat(16)}),
    parentSpanContext:{spanId:"c".repeat(16)},startTime:[1780000000,0],endTime:[1780000001,0],status:{code:0},
    attributes:{"gen_ai.request.model":"gpt-test-2026-10-20","gen_ai.input.messages":"private question","gen_ai.output.messages":"private answer",authorization:"secret","gen_ai.usage.input_tokens":20,"gen_ai.usage.output_tokens":5}};
  const exporter=createLoopiterSpanExporter({loop,context:()=>({learningContext:{tenantId:"acme"},releaseId:"release-1"})});
  const send=(spans:ReadableSpan[])=>new Promise<{code:number;error?:Error}>(r=>exporter.export(spans,r));
  assert.equal((await send([span,span])).code,0);await exporter.forceFlush();
  const rows=(await loop.list("executions")).items;assert.equal(rows.length,1);
  const row=rows[0]!;assert.equal(row.id,spanExecutionId("a".repeat(32),"b".repeat(16)));
  assert.equal(row.metadata.parentExecutionId,spanExecutionId("a".repeat(32),"c".repeat(16)));
  assert.equal(row.artifacts.model,"gpt-test-2026-10-20");assert.equal(state(row).status,"unknown");
  assert.doesNotMatch(JSON.stringify(row),/private|secret|authorization/);
  assert.equal((await send([{...span,status:{code:1}}])).code,1,"Changed duplicate evidence must not overwrite the original");
  await exporter.shutdown();assert.equal((await send([span])).code,1);
});
