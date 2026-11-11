/**
 * Typecheck the emitted declarations the way a consumer with skipLibCheck off
 * and without exactOptionalPropertyTypes would. Run after `npm run build`.
 */
import type { ArtifactVersions, JsonObject } from "../dist/src/contracts.js";

const versions: ArtifactVersions = { model: "m" };
const json: JsonObject = versions;
void json;
