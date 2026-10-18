import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NEXT_SHIMS } from "../src/plugin/shims-map.js";
import { findMiddleware, resolveServerConfig, generatePagesManifest } from "../src/plugin/index.js";
import getConfig, { setConfig } from "../src/shims/config.js";

const shimsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "shims");

test("next/dynamic, next/config, next/script and next/image have shims", () => {
  for (const mod of ["next/dynamic", "next/config", "next/script", "next/image"]) {
    assert.ok(NEXT_SHIMS[mod], `${mod} is mapped`);
    assert.ok(fs.existsSync(path.join(shimsDir, NEXT_SHIMS[mod])), `${mod} shim file exists`);
  }
});

test("getConfig returns what setConfig stored, with empty defaults", () => {
  setConfig(undefined);
  assert.deepEqual(getConfig(), { serverRuntimeConfig: {}, publicRuntimeConfig: {} });
  setConfig({ serverRuntimeConfig: { secret: 1 }, publicRuntimeConfig: { appName: "x" } });
  assert.equal(getConfig().publicRuntimeConfig.appName, "x");
});

test("next.config routing functions resolve and rewrites normalize", async () => {
  const resolved = await resolveServerConfig({
    redirects: async () => [{ source: "/a", destination: "/b", permanent: true }],
    rewrites: async () => [{ source: "/c", destination: "/d" }],
    publicRuntimeConfig: { appName: "x" },
  });
  assert.equal(resolved.redirects.length, 1);
  assert.deepEqual(resolved.rewrites.afterFiles, [{ source: "/c", destination: "/d" }]);
  assert.deepEqual(resolved.rewrites.beforeFiles, []);
  assert.deepEqual(resolved.headers, []);
  assert.equal(resolved.publicRuntimeConfig.appName, "x");
});

test("middleware.ts is found in the root and loaded only on the server", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-mw-"));
  assert.equal(findMiddleware(root), null);
  fs.writeFileSync(path.join(root, "middleware.ts"), "export function middleware() {}");
  const file = findMiddleware(root);
  assert.equal(file, path.join(root, "middleware.ts"));
  assert.match(generatePagesManifest("/p", ["index.tsx"], { server: true, middleware: file }), /loadMiddleware = \(\) => import/);
  assert.match(generatePagesManifest("/p", ["index.tsx"], { server: false, middleware: file }), /loadMiddleware = null/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("each render gets its own unified request context", async () => {
  const { getRequestContext } = await import("../src/unified-request-context.js");
  const { createUnifiedRequestContext, runWithUnifiedRequestContext } = await import("../src/server/render-context.js");
  const first = createUnifiedRequestContext();
  await runWithUnifiedRequestContext(first, async () => {
    await Promise.resolve();
    getRequestContext().serverInsertedHTMLCallbacks.push(() => "x");
  });
  assert.equal(first.serverInsertedHTMLCallbacks.length, 1);
  const second = createUnifiedRequestContext();
  runWithUnifiedRequestContext(second, () => assert.equal(getRequestContext().serverInsertedHTMLCallbacks.length, 0));
  assert.notEqual(getRequestContext(), getRequestContext());
});
