/**
 * Rewrite benchmarks/hotpotqa/pinned-eval.lock.json from the pinned cache.
 * The cache comes from benchmarks/hotpotqa/fetch.py. A correct rewrite is
 * byte-identical to the committed lock.
 *
 *   npm run build
 *   node dist/benchmarks/hotpotqa/write-eval-lock.js
 */
import { pathToFileURL } from "node:url";
import { writeHotpotEvalLock } from "./cache.js";

const invoked =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invoked) {
  const path = await writeHotpotEvalLock();
  console.log(path);
}
