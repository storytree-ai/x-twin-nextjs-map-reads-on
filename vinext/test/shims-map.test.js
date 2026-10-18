import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NEXT_SHIMS, nextShimAliases } from "../src/plugin/shims-map.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const shimsDir = path.join(here, "..", "src", "shims");

test("the Pages Router next/* modules all have shims", () => {
  for (const mod of ["next/link", "next/router", "next/head", "next/document", "next/app"]) {
    assert.ok(NEXT_SHIMS[mod], `${mod} is mapped`);
    assert.ok(fs.existsSync(path.join(shimsDir, NEXT_SHIMS[mod])), `${mod} shim file exists`);
  }
});

test("aliases match with and without .js and nothing else", () => {
  const aliases = nextShimAliases(shimsDir);
  const resolve = (id) => {
    const a = aliases.find((x) => x.find.test(id));
    return a ? id.replace(a.find, a.replacement) : null;
  };
  assert.equal(resolve("next/link"), path.join(shimsDir, NEXT_SHIMS["next/link"]));
  assert.equal(resolve("next/link.js"), path.join(shimsDir, NEXT_SHIMS["next/link"]));
  assert.equal(resolve("next/linker"), null);
  assert.equal(resolve("my-next/link"), null);
});
