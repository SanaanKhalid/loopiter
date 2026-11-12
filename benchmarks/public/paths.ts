import { existsSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, including when this file is loaded from dist/. */
export function repoRoot(metaUrl: string): string {
  let dir = dirname(fileURLToPath(metaUrl));
  const marker = `${sep}dist${sep}`;
  if (dir.includes(marker)) dir = dir.replace(marker, sep);
  for (;;) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "benchmarks")))
      return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Repository root not found.");
    dir = parent;
  }
}
