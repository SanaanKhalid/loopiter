import { pathToFileURL } from "node:url";
import { cliMain } from "../public/cli.js";
import { hotpotTask } from "./task.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await cliMain(hotpotTask);
