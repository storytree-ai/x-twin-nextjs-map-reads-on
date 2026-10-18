import { test } from "node:test";
import assert from "node:assert/strict";
import { transformCjs } from "../src/plugin/cjs.js";

test("require() in an ES module becomes a hoisted import with interop", () => {
  const out = transformCjs('const { random } = require("./random");\nexport default function Page() {}');
  assert.match(out, /^import \* as __vinext_require_0 from "\.\/random";/);
  assert.match(out, /const \{ random \} = __vinext_interop\(__vinext_require_0\);/);
});

test("a CommonJS file gets an ES default export of module.exports", () => {
  const out = transformCjs("module.exports = {\n  random: () => 4,\n};");
  assert.match(out, /const module = \{ exports: \{\} \}/);
  assert.match(out, /export default module\.exports;$/);
});

test("plain ES modules are left alone", () => {
  assert.equal(transformCjs('import x from "y";\nexport const a = x;'), null);
});
