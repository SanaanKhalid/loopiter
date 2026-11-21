import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("bundled controller loads failure-detail rules without a file read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loopiter-bundle-"));
  const outfile = join(dir, "controller.mjs");
  try {
    await build({
      absWorkingDir: root,
      entryPoints: ["src/improvement-controller.ts"],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile,
      logLevel: "silent",
    });
    const source = await readFile(outfile, "utf8");
    assert.doesNotMatch(source, /readFileSync/);
    assert.doesNotMatch(source, /from\s+["'][^"']*failure-detail-rules\.json["']/);
    assert.match(source, /inputMax:\s*32768/);
    const bundled = await import(pathToFileURL(outfile).href);
    assert.equal(
      bundled.failureDetailText("https://secret.example/a"),
      "[redacted]",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dist controller import loads failure-detail rules", async () => {
  const source = await readFile(
    new URL("../src/improvement-controller.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /failure-detail-rules\.json/);
  assert.doesNotMatch(source, /readFileSync/);
  const { failureDetailText } = await import("../src/improvement-controller.js");
  assert.equal(failureDetailText("https://secret.example/a"), "[redacted]");
});

test("node and python failure-detail rules match", async () => {
  const node = JSON.parse(
    await readFile(new URL("../../src/failure-detail-rules.json", import.meta.url), "utf8"),
  );
  const python = JSON.parse(
    await readFile(
      new URL("../../python/src/loopiter/failure_detail_rules.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(node, python);
});
