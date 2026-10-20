// Packed-consumer matrix adapted from Supermemory's AI SDK compatibility runner.
// Copyright (c) 2025 Supermemory Inc. MIT; see THIRD_PARTY_NOTICES.md.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "loopiter-integrations-"));
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    timeout: 180000,
  });
  if (result.status !== 0 || result.error)
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
      { cause: result.error },
    );
  return result.stdout;
};
const common = `
import assert from 'node:assert/strict';
import { FeedbackLoop, InMemoryStore } from 'loopiter';
const loop = new FeedbackLoop({store:new InMemoryStore(),namespace:'packed'});
const options = {loop,context:()=>({artifacts:{prompt:'v1'}})};
`;
try {
  run("npm", ["pack", "--pack-destination", work], root);
  const tarball = join(
    work,
    (await readdir(work)).find((name) => name.endsWith(".tgz")),
  );
  for (const entry of [
    {
      name: "ai-5",
      dependencies: { ai: "^5.0.0" },
      major: 5,
      mock: "MockLanguageModelV2",
    },
    {
      name: "ai-6",
      dependencies: { ai: "^6.0.0" },
      major: 6,
      mock: "MockLanguageModelV3",
    },
    {
      name: "ai-7",
      dependencies: { ai: "^7.0.0" },
      major: 7,
      mock: "MockLanguageModelV4",
    },
    { name: "openai-6", dependencies: { openai: "^6.0.0" } },
    { name: "openai-7", dependencies: { openai: "^7.0.0" } },
  ]) {
    const { mkdir } = await import("node:fs/promises");
    const directory = join(work, entry.name);
    await mkdir(directory);
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: {
          loopiter: `file:${tarball}`,
          typescript: "^5.9.3",
          "@types/node": "^24.0.0",
          ...entry.dependencies,
        },
      }),
    );
    run(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
      directory,
    );
    let fixture;
    if (entry.major) {
      const finish =
        entry.major === 5 ? "'stop'" : "{unified:'stop',raw:'stop'}";
      const usage =
        entry.major === 5
          ? "{inputTokens:2,outputTokens:1,totalTokens:3}"
          : "{inputTokens:{total:2,noCache:2,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}}";
      fixture = `${common}
import {generateText,streamText} from 'ai';
import {${entry.mock}} from 'ai/test';
import {withLoopiter} from 'loopiter/integrations/ai-sdk';
const model=withLoopiter(new ${entry.mock}({
  doGenerate:async()=>({content:[{type:'text',text:'hello'}],finishReason:${finish},usage:${usage},warnings:[]}),
  doStream:async()=>({stream:new ReadableStream({start(c){
    c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'text-start',id:'1'});
    c.enqueue({type:'text-delta',id:'1',delta:'hello'});c.enqueue({type:'text-end',id:'1'});
    c.enqueue({type:'finish',finishReason:${finish},usage:${usage}});c.close();
  }})}),
}),options);
assert.equal((await generateText({model,prompt:'hello',maxRetries:0})).text,'hello');
const stream=streamText({model,prompt:'hello',maxRetries:0});
for await(const _part of stream.fullStream) {}
assert.equal(await stream.text,'hello');
const rows=(await loop.list('executions')).items;
assert.equal(rows.length,2);
assert.ok(rows.every(row=>(row.metadata.loopiterCapture as {status:string}).status==='completed'));
`;
    } else {
      fixture = `${common}
import OpenAI from 'openai';
import {withLoopiter} from 'loopiter/integrations/openai';
const base=new OpenAI({apiKey:'no-network',maxRetries:0,fetch:async(url,init)=>{
  const params=JSON.parse(String(init?.body));
  const responses=String(url).endsWith('/responses');
  if(params.stream){
    const parts=responses
      ? [{type:'response.completed',response:{id:'resp-1',status:'completed',output:[]}}]
      : [{id:'chat-1',choices:[{index:0,delta:{content:'hello'},finish_reason:null}]},
         {id:'chat-1',choices:[{index:0,delta:{},finish_reason:'stop'}]}];
    const newline=String.fromCharCode(10,10);
    return new Response(parts.map(part=>'data: '+JSON.stringify(part)+newline).join('')+'data: [DONE]'+newline,{headers:{'content-type':'text/event-stream'}});
  }
  return new Response(JSON.stringify(responses ? {id:'resp-1',status:'completed',output:[]} : {
    id:'chat-1',object:'chat.completion',created:1,model:'fixture',choices:[{index:0,message:{role:'assistant',content:'hello'},finish_reason:'stop'}],usage:{total_tokens:3}
  }),{headers:{'content-type':'application/json','x-request-id':'packed'}});
}});
const original=base.chat.completions.create;
const client=withLoopiter(base,options);
const response=await client.chat.completions.create({model:'fixture',messages:[{role:'user',content:'hello'}]}).withResponse();
assert.equal(response.data.choices[0]?.message.content,'hello');assert.equal(response.request_id,'packed');
assert.equal(base.chat.completions.create,original);
const chatStream=await client.chat.completions.create({model:'fixture',messages:[{role:'user',content:'hello'}],stream:true});
for await(const _part of chatStream) {}
await client.responses.create({model:'fixture',input:'hello'});
const responseStream=await client.responses.create({model:'fixture',input:'hello',stream:true});
for await(const _part of responseStream) {}
const rows=(await loop.list('executions')).items;
assert.equal(rows.length,4);
assert.ok(rows.every(row=>(row.metadata.loopiterCapture as {status:string}).status==='completed'));
`;
    }
    await writeFile(join(directory, "consumer.mts"), fixture);
    run(
      process.execPath,
      [
        "node_modules/typescript/bin/tsc",
        "consumer.mts",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--strict",
        "--skipLibCheck",
        "--outDir",
        "built",
      ],
      directory,
    );
    run(process.execPath, ["built/consumer.mjs"], directory);
    const installed = JSON.parse(
      await readFile(
        join(directory, "node_modules/loopiter/package.json"),
        "utf8",
      ),
    );
    assert.equal(Object.keys(installed.dependencies ?? {}).length, 0);
    assert.match(
      await readFile(
        join(directory, "node_modules/loopiter/THIRD_PARTY_NOTICES.md"),
        "utf8",
      ),
      /Supermemory Inc/,
    );
    console.log(
      `${entry.name}: installed package types and runtime passed (mock providers).`,
    );
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
