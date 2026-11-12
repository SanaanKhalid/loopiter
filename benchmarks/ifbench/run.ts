import { pathToFileURL } from "node:url";
import { cliMain } from "../public/cli.js";
import { closeVerifier } from "./score.js";
import { ifbenchTask } from "./task.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await cliMain(ifbenchTask);
  } finally {
    await closeVerifier();
  }
}
