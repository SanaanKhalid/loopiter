import assert from "node:assert/strict";
import test from "node:test";
import { assertPacked, packedSurface } from "./packed-surface.mjs";

test("a stripped package fails the packed-surface check", () => {
  for (const [label, required] of Object.entries(packedSurface)) {
    assert.doesNotThrow(() => assertPacked(required, required, label));
    for (const name of required) {
      const stripped = required.filter((item) => item !== name);
      assert.throws(
        () => assertPacked(stripped, required, label),
        new RegExp(name.replaceAll(".", "\\.")),
        `${label} without ${name}`,
      );
    }
  }
});
