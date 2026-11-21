import { rmSync } from "node:fs";

const directory = process.argv[2] ?? "dist";
rmSync(directory, { recursive: true, force: true });
