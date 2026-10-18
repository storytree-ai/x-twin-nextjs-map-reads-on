import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { parseArgs, isBuiltAsset } from "../src/cli.js";
import { createStaticFileServer } from "../src/server/static-files.js";
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

test("public/ files reach the request pipeline in dev; the root's stay with Vite", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-public-"));
  fs.mkdirSync(path.join(root, "public"));
  fs.writeFileSync(path.join(root, "public", "robots.txt"), "User-agent: *");
  fs.writeFileSync(path.join(root, "vite.config.ts"), "");
  assert.equal(isPageRequest({ url: "/robots.txt" }, root), true);
  assert.equal(isPageRequest({ url: "/vite.config.ts" }, root), false);
});

test("the static file server serves a file under its dirs with the given status, never outside them", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-static-"));
  fs.writeFileSync(path.join(dir, "hello world.txt"), "hi");
  const serveFile = createStaticFileServer([dir]);
  const res = await new Promise((resolve) => {
    const out = { headers: {}, chunks: [] };
    const res = new PassThrough();
    res.setHeader = (k, v) => (out.headers[k.toLowerCase()] = v);
    res.on("data", (c) => out.chunks.push(c));
    res.on("finish", () => resolve({ ...out, statusCode: res.statusCode, body: Buffer.concat(out.chunks).toString() }));
    assert.equal(serveFile("/hello%20world.txt", { method: "GET" }, res, 403), true);
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, "hi");
  assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(serveFile("/missing.txt", { method: "GET" }, {}), false);
  fs.writeFileSync(`${dir}-outside.txt`, "secret");
  assert.equal(serveFile(`/..%2F${path.basename(dir)}-outside.txt`, { method: "GET" }, {}), false);
  assert.equal(serveFile("/hello%20world.txt", { method: "POST" }, {}), false);
});

test("vinext start serves its client build directly, except public/ copies, which go through the pipeline", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-start-"));
  const clientDir = path.join(root, "dist", "client");
  const publicDir = path.join(root, "public");
  fs.mkdirSync(path.join(clientDir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(publicDir, "assets"), { recursive: true });
  for (const file of ["assets/index-abc.js", "assets/logo.png", "robots.txt"]) fs.writeFileSync(path.join(clientDir, file), "");
  for (const file of ["assets/logo.png", "robots.txt"]) fs.writeFileSync(path.join(publicDir, file), "");
  const built = (p) => isBuiltAsset(clientDir, publicDir, p);
  assert.equal(built("/assets/index-abc.js"), true);
  assert.equal(built("/assets/logo.png"), false);
  assert.equal(built("/robots.txt"), false);
  assert.equal(built("/missing.js"), false);
  // Without public/ (a deployment of dist/ alone) the whole build is served directly.
  assert.equal(isBuiltAsset(clientDir, path.join(root, "nope"), "/robots.txt"), true);
});
