import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAppRouterRequest } from "../src/server/app-router/index.js";
import { NextResponse } from "../src/shims/server.js";

function fakeRes() {
  const headers = {};
  const chunks = [];
  return {
    statusCode: 200,
    headers,
    writableEnded: false,
    getHeader: (k) => headers[k.toLowerCase()],
    setHeader: (k, v) => {
      headers[k.toLowerCase()] = v;
    },
    removeHeader: (k) => {
      delete headers[k.toLowerCase()];
    },
    on() {},
    once() {},
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      this.writableEnded = true;
    },
    get body() {
      return Buffer.concat(chunks).toString();
    },
  };
}

const serverConfig = {
  headers: [{ source: "/(.*)", headers: [{ key: "x-config", value: "config" }, { key: "x-both", value: "config" }] }],
  redirects: [{ source: "/old", destination: "/about", permanent: true }],
  rewrites: {
    beforeFiles: [],
    afterFiles: [{ source: "/after", destination: "/" }],
    fallback: [{ source: "/to-pages", destination: "/legacy" }],
  },
};

function makeEntry() {
  const calls = { middleware: 0, rendered: [] };
  const entry = {
    serverConfig,
    routeKind: (pathname) => (pathname === "/" || pathname === "/about" ? "static" : null),
    loadMiddleware: async () => ({
      config: { matcher: ["/", "/about", "/rewrite-403", "/blocked", "/to-pages"] },
      middleware(request) {
        calls.middleware++;
        const { pathname } = request.nextUrl;
        if (pathname === "/rewrite-403") return NextResponse.rewrite(new URL("/", request.url), { status: 403 });
        if (pathname === "/blocked") return new Response("Blocked", { status: 403 });
        const headers = new Headers(request.headers);
        headers.set("x-from-mw", "1");
        const res = NextResponse.next({ request: { headers } });
        res.headers.set("x-both", "middleware");
        return res;
      },
    }),
    async default(request) {
      calls.rendered.push({ url: request.url, fromMw: request.headers.get("x-from-mw") });
      return new Response("page", { status: 200, headers: { "content-type": "text/html" } });
    },
  };
  return { entry, calls };
}

async function run(url, { headers = {}, pagesRouteKind = () => null } = {}) {
  const { entry, calls } = makeEntry();
  const req = { method: "GET", url, headers: { host: "localhost:3000", ...headers } };
  const res = fakeRes();
  const pages = [];
  await handleAppRouterRequest(req, res, {
    entry,
    pagesRouteKind,
    handlePages: async (r, _res, routed) => {
      pages.push(routed.pathname);
      res.end("pages");
    },
  });
  return { res, calls, pages };
}

test("an app page runs middleware once and renders with its request headers", async () => {
  const { res, calls } = await run("/about");
  assert.equal(calls.middleware, 1);
  assert.deepEqual(calls.rendered, [{ url: "http://localhost:3000/about", fromMw: "1" }]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "page");
  assert.equal(res.headers["x-config"], "config");
  assert.equal(res.headers["x-both"], "middleware");
  assert.equal(Object.keys(res.headers).some((k) => k.startsWith("x-middleware-")), false);
});

test("an RSC request is routed by its page path and rendered as RSC", async () => {
  const { calls } = await run("/index.rsc?x=1", { headers: { accept: "text/x-component" } });
  assert.equal(calls.middleware, 1);
  assert.equal(calls.rendered[0].url, "http://localhost:3000/index.rsc?x=1");
});

test("config redirects: a page gets a 308, the client router's RSC fetch a redirect header", async () => {
  const page = await run("/old");
  assert.equal(page.res.statusCode, 308);
  assert.equal(page.res.headers.location, "/about");
  const rsc = await run("/old.rsc", { headers: { accept: "text/x-component" } });
  assert.equal(rsc.res.statusCode, 200);
  assert.equal(rsc.res.headers["x-vinext-redirect"], "/about");
  const direct = await run("/old.rsc");
  assert.equal(direct.res.statusCode, 308);
  assert.equal(direct.res.headers.location, "/about");
});

test("a middleware rewrite renders the target with the rewrite's status", async () => {
  const { res, calls } = await run("/rewrite-403");
  assert.equal(calls.rendered[0].url, "http://localhost:3000/");
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, "page");
});

test("a middleware response answers without rendering", async () => {
  const { res, calls } = await run("/blocked");
  assert.equal(calls.rendered.length, 0);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, "Blocked");
});

test("afterFiles rewrites apply when no route matches", async () => {
  const { calls } = await run("/after");
  assert.equal(calls.rendered[0].url, "http://localhost:3000/");
});

test("a rewrite to a pages/ route hands over without running middleware again", async () => {
  const { calls, pages } = await run("/to-pages", { pagesRouteKind: (p) => (p === "/legacy" ? "static" : null) });
  assert.equal(calls.middleware, 1);
  assert.equal(calls.rendered.length, 0);
  assert.deepEqual(pages, ["/legacy"]);
});

test("afterFiles rewrites apply before a dynamic pages/ route; a static pages/ route comes first", async () => {
  const dynamicPages = (p) => (p === "/legacy" ? "static" : p.split("/").length === 2 ? "dynamic" : null);
  const rewritten = await run("/after", { pagesRouteKind: dynamicPages });
  assert.deepEqual(rewritten.pages, []);
  assert.equal(rewritten.calls.rendered[0].url, "http://localhost:3000/");
  const direct = await run("/legacy", { pagesRouteKind: dynamicPages });
  assert.deepEqual(direct.pages, ["/legacy"]);
});
