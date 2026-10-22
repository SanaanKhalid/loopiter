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
