import { test } from "node:test";
import assert from "node:assert/strict";
import { runRequestPipeline } from "../src/server/middleware-runner.js";
import { NextResponse } from "../src/shims/server.js";

function fakeRes() {
  const headers = {};
  return {
    statusCode: 200,
    headers,
    body: null,
    writableEnded: false,
    getHeader: (k) => headers[k.toLowerCase()],
    setHeader: (k, v) => {
      headers[k.toLowerCase()] = v;
    },
    removeHeader: (k) => {
      delete headers[k.toLowerCase()];
    },
    end(body) {
      this.body = body ?? null;
      this.writableEnded = true;
    },
  };
}

const config = {
  headers: [{ source: "/headers-first", headers: [{ key: "X-Source", value: "1" }] }],
  redirects: [{ source: "/redirect-first", destination: "/about", permanent: false }],
  rewrites: { beforeFiles: [{ source: "/gated", has: [{ type: "cookie", key: "mw" }], destination: "/about" }], afterFiles: [], fallback: [] },
};

function middleware(request) {
  const { pathname } = new URL(request.url);
  if (pathname === "/redirect-first") return new Response("middleware should not win", { status: 418 });
  if (pathname === "/headers-first") return NextResponse.rewrite(new URL("/ssr", request.url));
  if (pathname === "/throw") throw new Error("boom");
  if (pathname === "/mw-redirect") {
    return NextResponse.redirect(new URL("/about", request.url), { headers: { "set-cookie": "mw-redirect=1; Path=/" } });
  }
  if (pathname === "/rewrite-status") return NextResponse.rewrite(new URL("/?from=mw", request.url), { status: 403 });
  if (pathname === "/set-cookie") {
    const res = NextResponse.next();
    res.cookies.set("from-mw", "yes");
    return res;
  }
  if (pathname === "/gated") {
    const headers = new Headers(request.headers);
    headers.set("cookie", "mw=1");
    headers.delete("authorization");
    return NextResponse.next({ request: { headers } });
  }
  const res = NextResponse.next();
  res.headers.set("x-mw", "active");
  return res;
}

const run = (pathname, reqHeaders = {}, { search = "", isRsc = false } = {}) => {
  const req = { method: "GET", headers: { host: "localhost:3000", ...reqHeaders } };
  const res = fakeRes();
  const out = runRequestPipeline(req, res, {
    pathname,
    search,
    isData: false,
    isRsc,
    config,
    loadMiddleware: async () => ({ middleware, config: { matcher: "/((?!api).*)" } }),
  });
  return out.then((request) => ({ request, req, res }));
};

test("config redirects answer before middleware runs", async () => {
  const { request, res } = await run("/redirect-first");
  assert.equal(request, null);
  assert.equal(res.statusCode, 307);
  assert.equal(res.headers.location, "/about");
});

test("config headers match the original path even when middleware rewrites", async () => {
  const { request, res } = await run("/headers-first");
  assert.equal(request.url.pathname, "/ssr");
  assert.equal(res.headers["x-source"], "1");
});

test("middleware headers reach the response; a throw is a 500", async () => {
  const ok = await run("/about");
  assert.equal(ok.request.url.pathname, "/about");
  assert.equal(ok.res.headers["x-mw"], "active");
  const thrown = await run("/throw");
  assert.equal(thrown.request, null);
  assert.equal(thrown.res.statusCode, 500);
});

test("request header overrides replace the request's headers before beforeFiles rewrites", async () => {
  const { request, req } = await run("/gated", { authorization: "secret" });
  assert.equal(request.url.pathname, "/about");
  assert.equal(req.headers.cookie, "mw=1");
  assert.equal(req.headers.authorization, undefined);
});

test("api paths outside the matcher skip middleware", async () => {
  const { request, res } = await run("/api/hello");
  assert.equal(request.url.pathname, "/api/hello");
  assert.equal(res.headers["x-mw"], undefined);
});

test("a path starting with // stays on the request's host", async () => {
  const { request } = await run("//evil.test/about");
  assert.equal(request.url.host, "localhost:3000");
  assert.equal(request.url.pathname, "//evil.test/about");
});

test("a trailing slash redirects (308) to the path without it, keeping the query", async () => {
  const { request, res } = await run("/about/", {}, { search: "?foo=bar" });
  assert.equal(request, null);
  assert.equal(res.statusCode, 308);
  assert.equal(res.headers.location, "/about?foo=bar");
  assert.notEqual((await run("/")).request, null);
  assert.notEqual((await run("//example.com/")).request, null);
});

test("an RSC request's redirects reach the client router as x-vinext-redirect", async () => {
  const config = await run("/redirect-first", {}, { isRsc: true });
  assert.equal(config.request, null);
  assert.equal(config.res.statusCode, 200);
  assert.equal(config.res.headers["x-vinext-redirect"], "/about");
  assert.equal(config.res.headers.location, undefined);
  const mw = await run("/mw-redirect", {}, { isRsc: true });
  assert.equal(mw.res.headers["x-vinext-redirect"], "/about");
  assert.deepEqual(mw.res.headers["set-cookie"], ["mw-redirect=1; Path=/"]);
});

test("a middleware rewrite's status and query reach the routed request", async () => {
  const { request } = await run("/rewrite-status");
  assert.equal(request.url.pathname, "/");
  assert.equal(request.url.searchParams.get("from"), "mw");
  assert.equal(request.status, 403);
  assert.equal((await run("/about")).request.status, undefined);
});

test("cookies middleware sets are in the request's cookies for rendering", async () => {
  const { request, req, res } = await run("/set-cookie", { cookie: "a=1" });
  assert.equal(req.headers.cookie, "a=1; from-mw=yes");
  assert.equal(request.headers.get("cookie"), "a=1; from-mw=yes");
  assert.match([].concat(res.headers["set-cookie"]).join(), /from-mw=yes/);
});
