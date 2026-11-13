import { pathToFileURL } from "node:url";
import { ifbenchTask } from "../ifbench/task.js";
import { hotpotTask } from "../hotpotqa/task.js";
import { renderTaskEstimate } from "./estimate.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(renderTaskEstimate(ifbenchTask, process.env));
    process.stdout.write("\n");
    process.stdout.write(renderTaskEstimate(hotpotTask, process.env));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Estimate failed.");
    process.exit(2);
  }
}
