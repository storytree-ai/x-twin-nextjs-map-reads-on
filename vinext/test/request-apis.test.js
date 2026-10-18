import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithRequestContext, createRequestContext } from "../src/shims/internal/request-context.js";
import { headers, cookies, draftMode } from "../src/shims/headers.js";
import { NextRequest, NextResponse, after, connection } from "../src/shims/server.js";
import { callRouteHandler, routeCacheControl } from "../src/server/app-router/route-handler.js";
import { notFound, redirect } from "../src/shims/internal/navigation-errors.js";

function req(path = "/", init = {}) {
  return new Request(`http://localhost${path}`, init);
}

function inContext(request, phase, fn) {
  const ctx = createRequestContext(request, { phase });
  return runWithRequestContext(ctx, () => fn(ctx));
}

test("headers() reads the request, awaited or synchronously, and is read-only", async () => {
  const request = req("/", { headers: { "user-agent": "UA/1", "x-a": "1" } });
  await inContext(request, "render", async () => {
    const sync = headers();
    assert.equal(sync.get("user-agent"), "UA/1");
    assert.deepEqual(
      Array.from(sync).filter(([k]) => k.startsWith("x-")),
      [["x-a", "1"]],
    );
    const h = await headers();
    assert.equal(h.get("x-a"), "1");
    assert.throws(() => h.set("x-a", "2"), /Headers cannot be modified/);
    assert.throws(() => sync.delete("x-a"), /Headers cannot be modified/);
  });
});

test("cookies() reads request cookies and refuses writes during a render", async () => {
  const request = req("/", { headers: { cookie: "a=1; b=two" } });
  await inContext(request, "render", async () => {
    const c = await cookies();
    assert.equal(c.getAll().length, 2);
    assert.deepEqual(c.get("b"), { name: "b", value: "two" });
    assert.equal(c.has("a"), true);
    assert.throws(() => c.set("a", "2"), /Server Action or Route Handler/);
  });
});

test("cookies set in a route handler reach its response and later reads", async () => {
  const mod = {
    GET() {
      const jar = cookies();
      jar.set("session", "abc123", { path: "/", httpOnly: true });
      jar.delete("old");
      return NextResponse.json({ seen: cookies().get("session")?.value });
    },
  };
  const res = await callRouteHandler(mod, req("/api", { headers: { cookie: "old=1" } }), {});
  assert.deepEqual(await res.json(), { seen: "abc123" });
  const set = res.headers.getSetCookie();
  assert.ok(set.some((c) => c.startsWith("session=abc123") && /Path=\//.test(c) && /HttpOnly/i.test(c)));
  assert.ok(set.some((c) => c.startsWith("old=") && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)));
});

test("draftMode enable and disable toggle the bypass cookie", async () => {
  const enable = await callRouteHandler({ async GET() { (await draftMode()).enable(); return Response.json({}); } }, req(), {});
  const cookie = enable.headers.getSetCookie().find((c) => c.startsWith("__prerender_bypass="));
  assert.ok(cookie);
  const value = cookie.split(";")[0];
  await inContext(req("/", { headers: { cookie: value } }), "render", async () => {
    assert.equal((await draftMode()).isEnabled, true);
  });
  await inContext(req("/"), "render", async () => {
    assert.equal((await draftMode()).isEnabled, false);
  });
  const disable = await callRouteHandler({ async GET() { (await draftMode()).disable(); return Response.json({}); } }, req("/", { headers: { cookie: value } }), {});
  assert.ok(disable.headers.getSetCookie().some((c) => c.startsWith("__prerender_bypass=;") || /Max-Age=0/.test(c)));
});

test("connection() and dynamic APIs mark the request dynamic", async () => {
  await inContext(req(), "render", async (ctx) => {
    assert.equal(ctx.dynamic, false);
    await connection();
    assert.equal(ctx.dynamic, true);
  });
  await inContext(req(), "render", async (ctx) => {
    await headers();
    assert.equal(ctx.dynamic, true);
  });
});

test("after() callbacks run once the response is produced", async () => {
  let ran = 0;
  const res = await callRouteHandler(
    {
      POST() {
        after(async () => {
          ran++;
        });
        assert.equal(ran, 0);
        return NextResponse.json({ ok: true });
      },
    },
    req("/", { method: "POST" }),
    {},
  );
  assert.equal(ran, 0, "after() must not run before the response");
  await res.text();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ran, 1);
});

test("route handler method dispatch: HEAD, OPTIONS and 405", async () => {
  const getOnly = { GET: () => Response.json({ method: "GET" }) };
  const head = await callRouteHandler(getOnly, req("/", { method: "HEAD" }), {});
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const del = await callRouteHandler(getOnly, req("/", { method: "DELETE" }), {});
  assert.equal(del.status, 405);
  assert.equal(del.headers.get("allow"), null);
  const all = { GET() {}, POST() {}, PUT() {}, PATCH() {}, DELETE() {}, HEAD() {} };
  const options = await callRouteHandler(all, req("/", { method: "OPTIONS" }), {});
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("allow"), "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT");
  const onlyDefault = { default: () => Response.json({}) };
  assert.equal((await callRouteHandler(onlyDefault, req(), {})).status, 405);
});

test("route handler errors: throw 500 empty, notFound 404, redirect 307", async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    const boom = await callRouteHandler({ GET() { throw new Error("x"); } }, req(), {});
    assert.equal(boom.status, 500);
    assert.equal(await boom.text(), "");
  } finally {
    console.error = origError;
  }
  assert.equal((await callRouteHandler({ GET() { notFound(); } }, req(), {})).status, 404);
  const r = await callRouteHandler({ GET() { redirect("/about"); } }, req(), {});
  assert.equal(r.status, 307);
  assert.equal(r.headers.get("location"), "/about");
});

test("route handlers get params and a NextRequest", async () => {
  const res = await callRouteHandler(
    {
      async GET(request, { params }) {
        return Response.json({ id: params.id, awaited: (await params).id, path: request.nextUrl.pathname, c: request.cookies.get("k")?.value });
      },
    },
    req("/api/items/42", { headers: { cookie: "k=v" } }),
    { id: "42" },
  );
  assert.deepEqual(await res.json(), { id: "42", awaited: "42", path: "/api/items/42", c: "v" });
});

test("GET with revalidate gets s-maxage unless dynamic or self-set", async () => {
  const fresh = { revalidate: 1, GET: () => Response.json({ t: 1 }) };
  assert.equal((await callRouteHandler(fresh, req(), {})).headers.get("cache-control"), "s-maxage=1, stale-while-revalidate");
  const readsRequest = { revalidate: 60, GET: (r) => Response.json({ p: r.headers.get("x") }) };
  assert.equal((await callRouteHandler(readsRequest, req(), {})).headers.get("cache-control"), null);
  const readsHeaders = { revalidate: 60, async GET() { await headers(); return Response.json({}); } };
  assert.equal((await callRouteHandler(readsHeaders, req(), {})).headers.get("cache-control"), null);
  const own = { revalidate: 60, GET: () => new Response("x", { headers: { "Cache-Control": "public, max-age=300" } }) };
  assert.equal((await callRouteHandler(own, req(), {})).headers.get("cache-control"), "public, max-age=300");
  const forced = { revalidate: 60, dynamic: "force-dynamic", GET: () => Response.json({}) };
  assert.equal((await callRouteHandler(forced, req(), {})).headers.get("cache-control"), null);
  const zero = { revalidate: 0, GET: () => Response.json({}) };
  assert.equal((await callRouteHandler(zero, req(), {})).headers.get("cache-control"), null);
  assert.equal(routeCacheControl({ revalidate: 5 }, "POST", false), null);
});

test("NextResponse helpers and NextRequest", async () => {
  const json = NextResponse.json({ a: 1 }, { status: 201, headers: { "x-y": "z" } });
  assert.equal(json.status, 201);
  assert.equal(json.headers.get("x-y"), "z");
  assert.match(json.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await json.json(), { a: 1 });
  const redir = NextResponse.redirect(new URL("http://localhost/about"));
  assert.equal(redir.status, 307);
  assert.equal(redir.headers.get("location"), "http://localhost/about");
  assert.equal(NextResponse.redirect("https://nextjs.org/", 308).status, 308);
  const next = NextResponse.next();
  assert.equal(next.headers.get("x-middleware-next"), "1");
  const rewrite = NextResponse.rewrite(new URL("http://localhost/"));
  assert.equal(rewrite.headers.get("x-middleware-rewrite"), "http://localhost/");
  const withCookie = NextResponse.json({});
  withCookie.cookies.set("t", "x", { path: "/" });
  assert.ok(withCookie.headers.getSetCookie()[0].startsWith("t=x"));
  assert.equal(withCookie.cookies.get("t").value, "x");
  const nr = new NextRequest("http://localhost/a/b?q=1", { headers: { cookie: "s=1" } });
  assert.equal(nr.nextUrl.pathname, "/a/b");
  assert.equal(nr.nextUrl.searchParams.get("q"), "1");
  assert.equal(nr.nextUrl.clone().href, "http://localhost/a/b?q=1");
  assert.equal(nr.cookies.get("s").value, "1");
});

test("page Cache-Control follows segment config and dynamic API use", async () => {
  const { resolveSegmentConfig, pageCacheControl } = await import("../src/server/app-router/segment-config.js");
  const config = resolveSegmentConfig([{ revalidate: 60 }, {}, { revalidate: 1 }]);
  assert.equal(config.revalidate, 1);
  assert.equal(pageCacheControl(config, false), "s-maxage=1, stale-while-revalidate");
  assert.match(pageCacheControl(config, true), /no-store/);
  assert.match(pageCacheControl(resolveSegmentConfig([{ dynamic: "force-dynamic" }]), false), /no-store/);
  assert.equal(pageCacheControl(resolveSegmentConfig([{}, { revalidate: false }]), false), null);
  assert.equal(pageCacheControl(resolveSegmentConfig([{ revalidate: 0 }]), false).includes("no-store"), true);
});

test("a route handler's request can be forwarded and re-wrapped", async () => {
  const forwarded = await callRouteHandler(
    { async POST(request) { return Response.json({ body: await new Request(request).text() }); } },
    req("/api/fwd", { method: "POST", body: "hi" }),
    {},
  );
  assert.equal(forwarded.status, 200);
  assert.deepEqual(await forwarded.json(), { body: "hi" });
  const wrapped = await callRouteHandler(
    { GET(request) { const w = new NextRequest(request); return Response.json({ path: w.nextUrl.pathname, ua: w.headers.get("user-agent") }); } },
    req("/api/wrap", { headers: { "user-agent": "UA/2" } }),
    {},
  );
  assert.equal(wrapped.status, 200);
  assert.deepEqual(await wrapped.json(), { path: "/api/wrap", ua: "UA/2" });
});

test("a promise given to after() that rejects early never crashes the process", async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  const origError = console.error;
  console.error = () => {};
  try {
    const res = await callRouteHandler(
      {
        async GET() {
          after(Promise.reject(new Error("rej")));
          await new Promise((r) => setTimeout(r, 10));
          return Response.json({ ok: true });
        },
      },
      req(),
      {},
    );
    await new Promise((r) => setTimeout(r, 10));
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off("unhandledRejection", onUnhandled);
    console.error = origError;
  }
  assert.deepEqual(unhandled, []);
});

test("a cacheable page's Cache-Control waits for the whole render", async () => {
  const { finalizeCacheControl } = await import("../src/server/app-router/segment-config.js");
  const config = { revalidate: 60, dynamic: "auto" };
  const ctx = { dynamic: false };
  // A stream whose later chunk is rendered by a component that reads a dynamic API.
  const stream = new ReadableStream({
    async pull(controller) {
      await new Promise((r) => setTimeout(r, 5));
      if (!this.sent) {
        this.sent = true;
        controller.enqueue(new TextEncoder().encode("<p>shell</p>"));
        return;
      }
      ctx.dynamic = true;
      controller.enqueue(new TextEncoder().encode("<p>late</p>"));
      controller.close();
    },
  });
  const { body, cacheControl } = await finalizeCacheControl(stream, config, () => ctx.dynamic);
  assert.match(cacheControl, /no-store/);
  assert.equal(await new Response(body).text(), "<p>shell</p><p>late</p>");
  const plain = await finalizeCacheControl(new Response("x").body, { revalidate: undefined, dynamic: "auto" }, () => false);
  assert.equal(plain.cacheControl, null);
});
