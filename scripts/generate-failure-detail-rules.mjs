import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = join(root, "python/src/loopiter/failure_detail_rules.json");
const rules = JSON.parse(readFileSync(source, "utf8"));
const output = `// Generated from python/src/loopiter/failure_detail_rules.json.
// Regenerate with: node scripts/generate-failure-detail-rules.mjs
export default ${JSON.stringify(rules, null, 2)} as const;
`;
writeFileSync(join(root, "src/failure-detail-rules.ts"), output);
