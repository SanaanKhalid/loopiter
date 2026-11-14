import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertPacked, packedSurface } from "./packed-surface.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit ${result.status}`);
}

async function filesUnder(directory, base = directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path, base)));
    else found.push(relative(base, path).split(sep).join("/"));
  }
  return found;
}

async function checkNode(temporary) {
  run("npm", ["pack", "--pack-destination", temporary], root);
  const tarballs = (await readdir(temporary)).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error("Expected one npm tarball.");
  await writeFile(
    join(temporary, "package.json"),
    JSON.stringify({ name: "loopiter-packed-consumer", private: true, type: "module" }),
  );
  run(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      resolve(temporary, tarballs[0]),
    ],
    temporary,
  );
  const installed = join(temporary, "node_modules/loopiter");
  const installedReal = resolve(installed);
  if (installedReal.startsWith(resolve(root) + sep)) {
    throw new Error("Node consumer resolved the repository checkout.");
  }
  assertPacked(await filesUnder(installed), packedSurface.node, "node");
  const fixture = JSON.parse(
    await readFile(join(root, "python/tests/fixtures/autonomy.json"), "utf8"),
  );
  await writeFile(join(temporary, "policy.json"), JSON.stringify(fixture.policy));
  await writeFile(
    join(temporary, "surface.mjs"),
    `
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readAgentGuide } from "loopiter/onboarding";
import { createObserver } from "loopiter/integrations/observe";
import { createLoopiterSpanExporter } from "loopiter/integrations/otel";
const root = process.env.PACKED_ROOT;
const guide = await readAgentGuide();
if (guide !== await readFile(join(root, "AGENT_GUIDE.md"), "utf8")) {
  throw new Error("setup module did not read the packed agent guide");
}
const links = [];
for (const target of guide.matchAll(/\\[[^\\]]*\\]\\(([^)\\s]+)\\)/g)) {
  const raw = target[1];
  if (raw.includes("://") || raw.startsWith("#")) continue;
  const path = raw.split("#")[0].split("?")[0];
  if (path) links.push(path);
}
if (!links.includes("docs/application-observation.md")) {
  throw new Error("agent guide does not link to the observation document");
}
for (const path of links) {
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error("agent guide link is not inside the package: " + path);
  }
  await readFile(join(root, path), "utf8");
}
if (typeof createObserver !== "function" || typeof createLoopiterSpanExporter !== "function") {
  throw new Error("observation modules missing");
}
console.log("packed node surface ok");
`,
  );
  run(process.execPath, ["surface.mjs"], temporary, {
    ...process.env,
    PACKED_ROOT: installed,
  });
  run("npx", ["--no-install", "loopiter", "init", "--directory", "setup"], temporary);
  const copied = await readFile(join(temporary, "setup/AGENT_GUIDE.md"), "utf8");
  if (!copied.includes("self-hosted SDK/library")) {
    throw new Error("init did not copy the packed agent guide");
  }
  await writeFile(
    join(temporary, "worker.mjs"),
    `
import { readFileSync } from "node:fs";
import { FeedbackLoop, InMemoryStore, ImprovementController } from "loopiter";
const policy = JSON.parse(readFileSync(new URL("./policy.json", import.meta.url), "utf8"));
const never = async () => { throw new Error("no model calls"); };
const workflow = {
  id: "packed", version: "1", optimizerVersion: "1", evaluatorVersion: "1", policy,
  artifact: async () => ({ artifactVersion: "baseline", configurationHash: "fixed" }),
  dataset: async () => ({ version: "1", optimization: [], validation: [], audit: [] }),
  propose: never, evaluate: never, observe: never,
  deployment: { apply: never, inspect: never, rollback: never },
};
const probe = new ImprovementController(
  new FeedbackLoop({ store: new InMemoryStore(), namespace: "packed/default" }),
  { workflows: [workflow] },
);
if (probe.options.mode !== "autonomous" || probe.options.selfImproving !== true) {
  throw new Error("installed controller default is not autonomous with self-improving on");
}
export async function createIntegration() {
  const loop = new FeedbackLoop({ store: new InMemoryStore(), namespace: "packed/node" });
  return {
    loop,
    workflows: [workflow],
    close: async () => { await loop.close(); },
  };
}
`,
  );
  const tick = spawnSync(
    "npx",
    ["--no-install", "loopiter", "worker", "--module", "worker.mjs", "--once"],
    { cwd: temporary, encoding: "utf8" },
  );
  if (tick.status !== 0) throw new Error(tick.stderr || "node tick failed");
  const state = JSON.parse(tick.stdout).state;
  if (state !== "waiting_for_evidence") throw new Error(`packed node tick returned ${state}`);
  console.log("Node tarball onboarding check passed.");
}

function checkPython() {
  const out = join(tmpdir(), `loopiter-packed-py-out-${process.pid}.json`);
  run(process.env.PYTHON || "python3", [
    join(root, "scripts/packed-onboarding-check.py"),
    "--out",
    out,
  ], root);
  return out;
}

const invoked =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invoked) {
  const temporary = await mkdtemp(join(tmpdir(), "loopiter-packed-node-"));
  try {
    await checkNode(temporary);
    const pythonOut = checkPython();
    const reports = JSON.parse(await readFile(pythonOut, "utf8"));
    if (reports.length !== 2) throw new Error("Expected a wheel report and an sdist report.");
    for (const report of reports) {
      assertPacked(report.files, packedSurface.python, `python ${report.kind}`);
    }
    await rm(pythonOut, { force: true });
    console.log("Packed onboarding check passed.");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
