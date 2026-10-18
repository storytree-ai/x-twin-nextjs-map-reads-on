import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPagesRoutes, matchPagesRoute } from "../src/routing/pages-routes.js";

const files = [
  "_app.tsx",
  "_document.tsx",
  "404.tsx",
  "index.tsx",
  "about.tsx",
  "posts/[id].tsx",
  "posts/missing.tsx",
  "docs/[...slug].tsx",
  "sign-up/[[...sign-up]]/index.tsx",
  "api/hello.ts",
  "api/users/[id].ts",
  "types.d.ts",
];

test("builds patterns from file paths and skips special files", () => {
  const routes = buildPagesRoutes(files);
  const patterns = routes.map((r) => r.pattern).sort();
  assert.deepEqual(patterns, [
    "/",
    "/about",
    "/api/hello",
    "/api/users/[id]",
    "/docs/[...slug]",
    "/posts/[id]",
    "/posts/missing",
    "/sign-up/[[...sign-up]]",
  ]);
  const api = routes.find((r) => r.pattern === "/api/users/[id]");
  assert.equal(api.isApi, true);
  assert.equal(api.file, "api/users/[id].ts");
  assert.equal(routes.find((r) => r.pattern === "/about").isApi, false);
});

test("static segments win over dynamic ones", () => {
  const routes = buildPagesRoutes(files);
  assert.equal(matchPagesRoute(routes, "/posts/missing").route.pattern, "/posts/missing");
  const m = matchPagesRoute(routes, "/posts/123");
  assert.equal(m.route.pattern, "/posts/[id]");
  assert.deepEqual(m.params, { id: "123" });
});

test("dynamic wins over catch-all, catch-all over optional catch-all", () => {
  const routes = buildPagesRoutes(["[id].tsx", "[...all].tsx", "[[...opt]].tsx", "a/[x].tsx", "a/[...rest].tsx"]);
  assert.equal(matchPagesRoute(routes, "/one").route.pattern, "/[id]");
  assert.equal(matchPagesRoute(routes, "/one/two").route.pattern, "/[...all]");
  assert.equal(matchPagesRoute(routes, "/").route.pattern, "/[[...opt]]");
  assert.equal(matchPagesRoute(routes, "/a/b").route.pattern, "/a/[x]");
  assert.deepEqual(matchPagesRoute(routes, "/a/b/c").params, { rest: ["b", "c"] });
});

test("catch-all params are decoded arrays; optional catch-all matches the bare path", () => {
  const routes = buildPagesRoutes(files);
  assert.deepEqual(matchPagesRoute(routes, "/docs/api/v2/users").params, { slug: ["api", "v2", "users"] });
  assert.equal(matchPagesRoute(routes, "/docs"), null);
  assert.deepEqual(matchPagesRoute(routes, "/sign-up").params, {});
  assert.deepEqual(matchPagesRoute(routes, "/sign-up/a/b").params, { "sign-up": ["a", "b"] });
  assert.deepEqual(matchPagesRoute(routes, "/posts/hello%20world").params, { id: "hello world" });
});

test("trailing slashes and unknown paths", () => {
  const routes = buildPagesRoutes(files);
  assert.equal(matchPagesRoute(routes, "/about/").route.pattern, "/about");
  assert.equal(matchPagesRoute(routes, "/nope"), null);
  assert.equal(matchPagesRoute(routes, "/").route.pattern, "/");
});

test("static segments with non-ASCII names match their encoded form", () => {
  const routes = buildPagesRoutes(["café.tsx", "[x].tsx"]);
  assert.equal(matchPagesRoute(routes, "/caf%C3%A9").route.pattern, "/café");
});
