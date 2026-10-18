import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileSource,
  matchRule,
  matchesMiddleware,
  findRedirect,
  collectHeaders,
  findRewrite,
} from "../src/server/request-pipeline.js";

const req = (url, headers = {}) => ({ url: new URL(url, "http://localhost"), headers: new Headers(headers) });

test("source patterns: named params, repeats, wildcards and raw groups", () => {
  assert.deepEqual(compileSource("/repeat/:id").match("/repeat/7"), { id: "7" });
  assert.equal(compileSource("/repeat/:id").match("/repeat/7/8"), null);
  assert.deepEqual(compileSource("/blog/:path*").match("/blog/a/b"), { path: "a/b" });
  assert.deepEqual(compileSource("/blog/:path*").match("/blog"), { path: undefined });
  assert.equal(compileSource("/blog/:path+").match("/blog"), null);
  assert.deepEqual(compileSource("/n/:id(\\d+)").match("/n/42"), { id: "42" });
  assert.equal(compileSource("/n/:id(\\d+)").match("/n/x"), null);
  assert.ok(compileSource("/api/(.*)").match("/api/hello"));
  const mw = compileSource("/((?!api|_next|favicon\\.ico|mw-object-gated).*)");
  assert.ok(mw.match("/about"));
  assert.ok(mw.match("/"));
  assert.equal(mw.match("/api/hello"), null);
  assert.equal(mw.match("/favicon.ico"), null);
});

test("has and missing conditions read headers, cookies and the query", () => {
  const rule = { source: "/about", has: [{ type: "cookie", key: "logged-in" }] };
  assert.ok(matchRule(rule, req("/about", { cookie: "logged-in=1" })));
  assert.equal(matchRule(rule, req("/about")), null);
  const missing = { source: "/about", missing: [{ type: "cookie", key: "logged-in" }] };
  assert.ok(matchRule(missing, req("/about")));
  const valued = { source: "/x", has: [{ type: "header", key: "x-mw-allow", value: "1" }, { type: "query", key: "q" }] };
  assert.ok(matchRule(valued, req("/x?q=", { "x-mw-allow": "1" })));
  assert.equal(matchRule(valued, req("/x?q=", { "x-mw-allow": "2" })), null);
});

test("redirects fill params into the destination and keep the query", () => {
  const redirects = [
    { source: "/old-about", destination: "/about", permanent: true },
    { source: "/repeat-redirect/:id", destination: "/docs/:id/:id", permanent: false },
  ];
  assert.deepEqual(findRedirect(redirects, req("/old-about?x=1")), { destination: "/about?x=1", status: 308 });
  assert.deepEqual(findRedirect(redirects, req("/repeat-redirect/z")), { destination: "/docs/z/z", status: 307 });
  assert.equal(findRedirect(redirects, req("/about")), null);
});

test("headers collect from every matching rule", () => {
  const rules = [
    { source: "/api/(.*)", headers: [{ key: "X-Custom-Header", value: "vinext" }] },
    { source: "/ssr", headers: [{ key: "Vary", value: "Accept-Language" }] },
  ];
  assert.deepEqual(collectHeaders(rules, req("/api/hello")), [{ key: "X-Custom-Header", value: "vinext" }]);
  assert.deepEqual(collectHeaders(rules, req("/about")), []);
});

test("rewrites resolve to a new path and query", () => {
  const rules = [{ source: "/repeat-rewrite/:id", destination: "/docs/:id/:id" }];
  const out = findRewrite(rules, req("/repeat-rewrite/q?a=1"));
  assert.equal(out.pathname, "/docs/q/q");
  assert.equal(out.searchParams.get("a"), "1");
  assert.equal(findRewrite(rules, req("/elsewhere")), null);
});

test("middleware matchers: strings, objects with has/missing, and the default", () => {
  const config = {
    matcher: [
      "/((?!api|_next|favicon\\.ico|mw-object-gated).*)",
      { source: "/mw-object-gated", has: [{ type: "header", key: "x-mw-allow", value: "1" }], missing: [{ type: "cookie", key: "mw-blocked" }] },
    ],
  };
  assert.equal(matchesMiddleware(config, req("/about")), true);
  assert.equal(matchesMiddleware(config, req("/api/hello")), false);
  assert.equal(matchesMiddleware(config, req("/mw-object-gated")), false);
  assert.equal(matchesMiddleware(config, req("/mw-object-gated", { "x-mw-allow": "1" })), true);
  assert.equal(matchesMiddleware(config, req("/mw-object-gated", { "x-mw-allow": "1", cookie: "mw-blocked=1" })), false);
  assert.equal(matchesMiddleware(undefined, req("/anything")), true);
  assert.equal(matchesMiddleware({ matcher: "/about/:path*" }, req("/about/x")), true);
});

test("has values become params, and rewrites pass unused params as query", () => {
  const rule = { source: "/team", has: [{ type: "query", key: "slug" }, { type: "header", key: "x-region", value: "(?<region>eu|us)" }], destination: "/teams/:slug/:region" };
  assert.deepEqual(matchRule(rule, req("/team?slug=a", { "x-region": "eu" })), { slug: "a", region: "eu" });
  const out = findRewrite([{ source: "/p/:id/:extra", destination: "/post/:id" }], req("/p/1/more"));
  assert.equal(out.pathname, "/post/1");
  assert.equal(out.searchParams.get("extra"), "more");
});
