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

test("dotted page paths render unless a file with that path exists", () => {
  const root = "/nonexistent-root";
  assert.equal(isPageRequest({ url: "/posts/v1.2" }, root), true);
  assert.equal(isPageRequest({ url: "/src/index.js" }, process.cwd()), false);
  assert.equal(isPageRequest({ url: "/package.json?import" }, process.cwd()), false);
});

test("Vite's CORS handling lets OPTIONS requests through to route handlers", async () => {
  const { default: vinext } = await import("../src/plugin/index.js");
  const plugins = [vinext({ appDir: false })].flat();
  const config = await plugins[0].config({ root: "/nonexistent-root" }, { command: "serve" });
  assert.equal(config.server.cors.preflightContinue, true);
  assert.ok(config.server.cors.origin.test("http://localhost:3000"));
  assert.ok(!config.server.cors.origin.test("https://evil.example"));
  const custom = await plugins[0].config({ root: "/nonexistent-root", server: { cors: false } }, { command: "serve" });
  assert.equal(custom.server, undefined);
});
