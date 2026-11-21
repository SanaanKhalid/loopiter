import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("clean-dist removes a stale rules file before pack", async () => {
  const directory = join(tmpdir(), `loopiter-dist-${Date.now()}`);
  await mkdir(join(directory, "src"), { recursive: true });
  const stale = join(directory, "src/failure-detail-rules.json");
  await writeFile(stale, "{}");
  const result = spawnSync(process.execPath, ["scripts/clean-dist.mjs", directory], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(access(stale));
});
