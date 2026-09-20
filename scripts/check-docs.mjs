import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";
const root = fileURLToPath(new URL("..", import.meta.url));
const build = spawnSync("npm", ["run", "build"], {
  cwd: root,
  stdio: "inherit",
});
assert.equal(build.status, 0);
const files = [
  "README.md",
  ...(await readdir(join(root, "fern/pages")))
    .filter((f) => f.endsWith(".mdx"))
    .map((f) => `fern/pages/${f}`),
  "examples/prompt-improvement/README.md",
];
const directory = await mkdtemp(join(root, ".doccheck-"));
try {
  const navigation = await readFile(join(root, "fern/docs.yml"), "utf8");
  assert.match(navigation, /^default-language: python$/m);
  assert.match(navigation, /tabs:\s+python:/);
  assert.match(navigation, /navigation:\s+- tab: python/);
  const pythonNavigation = navigation.split("navigation:")[1].split("  - tab: nodejs")[0];
  for (const page of ["overview", "python", "python-api", "autonomy-integration", "autonomy-policy", "autonomy-datasets", "autonomy-adapters", "autonomy-operations"]) {
    assert.ok(pythonNavigation.includes(`path: pages/${page}.mdx`), `${page} must remain in the Python documentation path`);
  }
  const snippets = [];
  for (const file of files) {
    const content = await readFile(join(root, file), "utf8");
    for (const group of content.matchAll(/<Tabs>([\s\S]*?)<\/Tabs>/g)) {
      if (group[1].includes('title="Python"') && group[1].includes('title="Node.js"')) {
        assert.ok(group[1].indexOf('title="Python"') < group[1].indexOf('title="Node.js"'), `${file}: shared examples must show Python first`);
      }
    }
    assert.ok(
      !content.includes("YOUR_REPOSITORY_URL"),
      `${file}: placeholder clone instruction`,
    );
    for (const match of content.matchAll(
      /```(?:ts|typescript)\s*\n([\s\S]*?)```/g,
    ))
      snippets.push({ file, code: match[1] });
  }
  const page = await readFile(join(root, "website/app/page.tsx"), "utf8");
  const landingSnippet = page.match(/const code = `([\s\S]*?)`;/);
  assert.ok(landingSnippet, "Landing-page example must remain compile checked");
  snippets.push({ file: "website/app/page.tsx", code: landingSnippet[1] });
  assert.ok(snippets.length >= 6, "No runnable documentation found");
  const names = [];
  for (const [index, snippet] of snippets.entries()) {
    const name = join(directory, `example-${index}.mts`);
    names.push(name);
    await writeFile(name, `${snippet.code}\nexport {};\n`);
  }
  const program = ts.createProgram(names, {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) {
    console.error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: () => root,
        getCanonicalFileName: (f) => f,
        getNewLine: () => "\n",
      }),
    );
    throw new Error("Runnable docs did not compile");
  }
  const docsLinks = await readFile(
    join(root, "website/lib/docs-links.ts"),
    "utf8",
  );
  assert.ok(docsLinks.includes("https://loopiter.docs.buildwithfern.com"));
  const redirect = await readFile(
    join(root, "website/app/docs/page.tsx"),
    "utf8",
  );
  assert.ok(
    redirect.includes(
      "window.location.replace(docsHref(window.location.hash))",
    ),
  );
  console.log(
    `Compiled ${snippets.length} complete documentation examples, including the landing page.`,
  );
  // Validate the complete documented policy at runtime, not just its TypeScript shape.
  const policyExample = snippets.find((s) => s.file === "fern/pages/autonomy-policy.mdx");
  assert.ok(policyExample, "Complete autonomy policy example is required");
  const compiledPolicy = ts.transpileModule(policyExample.code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  const { supportPolicy } = await import(
    `data:text/javascript;base64,${Buffer.from(compiledPolicy).toString("base64")}`
  );
  const { validatePolicy } = await import("../dist/src/improvement-evidence.js");
  validatePolicy(supportPolicy);
  console.log("Documented complete Node autonomy policy passed runtime validation.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
