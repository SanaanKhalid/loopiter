import { createHash } from "node:crypto";
import { finite, nonempty, fail } from "./utils.js";
/** Deterministic entity bucket, not a traffic router. Persist assignments in your application. */
export function assignCohort(input: {
  experimentId: string;
  entityId: string;
  salt: string;
  exposure: number;
}) {
  for (const key of ["experimentId", "entityId", "salt"] as const)
    nonempty(input[key], key);
  finite(input.exposure, "exposure", 0);
  if (input.exposure > 1) fail("invalid_input", "Exposure must be in [0,1].");
  const parts = [input.experimentId, input.entityId, input.salt];
  const framed = parts
    .map((x) => `${Buffer.byteLength(x, "utf8")}:${x}`)
    .join("");
  const digest = createHash("sha256").update(framed, "utf8").digest("hex");
  const bucket = parseInt(digest.slice(0, 13), 16) / 2 ** 52;
  return {
    cohort:
      bucket < input.exposure ? ("candidate" as const) : ("control" as const),
    bucket,
    method: "sha256-framed-v1",
    entityFingerprint: digest,
  };
}
