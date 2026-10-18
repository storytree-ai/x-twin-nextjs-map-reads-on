import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli.js";
import { isPageRequest, generatePagesManifest } from "../src/plugin/index.js";

test("CLI parses the command and -p/--port", () => {
  assert.deepEqual(parseArgs(["dev", "-p", "3411"]), { command: "dev", port: 3411, hostname: undefined });
  assert.equal(parseArgs(["start", "--port=4000"]).port, 4000);
  assert.equal(parseArgs(["build"]).command, "build");
});

test("the dev middleware renders pages and leaves Vite's requests alone", () => {
  const page = (url) => isPageRequest({ url });
  assert.equal(page("/"), true);
  assert.equal(page("/posts/123?x=1"), true);
  assert.equal(page("/api/users/42"), true);
  assert.equal(page("/_next/data/development/ssr.json"), true);
  assert.equal(page("/@vite/client"), false);
  assert.equal(page("/@fs/x/y.js"), false);
  assert.equal(page("/node_modules/vinext/dist/client/pages-entry.js"), false);
  assert.equal(page("/pages/index.tsx"), false);
  assert.equal(page("/favicon.ico"), false);
});

test("the client manifest leaves out API routes and _document", () => {
  const files = ["_app.tsx", "_document.tsx", "index.tsx", "api/hello.ts", "404.tsx"];
  const client = generatePagesManifest("/app/pages", files, { server: false });
  assert.match(client, /routeFiles = \["index.tsx"\]/);
  assert.match(client, /loadDocument = null/);
  assert.match(client, /has404 = true/);
  const server = generatePagesManifest("/app/pages", files, { server: true });
  assert.match(server, /"api\/hello.ts"/);
  assert.match(server, /loadDocument = \(\) => import\("\/app\/pages\/_document.tsx"\)/);
});
