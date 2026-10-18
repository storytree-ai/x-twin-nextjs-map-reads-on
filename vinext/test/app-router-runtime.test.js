import { test } from "node:test";
import assert from "node:assert/strict";
import { rscUrl, parseRscPath } from "../src/shared/rsc-url.js";
import { injectPayload } from "../src/server/app-router/inline-payload.js";
import {
  notFound,
  forbidden,
  redirect,
  permanentRedirect,
  httpFallbackStatus,
  redirectInfo,
  isNavigationError,
} from "../src/shims/internal/navigation-errors.js";
import { generateAppManifest } from "../src/plugin/index.js";

function streamOf(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function text(stream) {
  return new Response(stream).text();
}

test("RSC payload URLs round-trip page URLs", () => {
  assert.equal(rscUrl("/about"), "/about.rsc");
  assert.equal(rscUrl("/"), "/index.rsc");
  assert.equal(rscUrl("http://x.test/blog/a/?q=1"), "/blog/a.rsc?q=1");
  assert.deepEqual(parseRscPath("/about.rsc"), { pathname: "/about", isRsc: true });
  assert.deepEqual(parseRscPath("/index.rsc"), { pathname: "/", isRsc: true });
  assert.deepEqual(parseRscPath("/about"), { pathname: "/about", isRsc: false });
});

test("the RSC payload is inlined as scripts before </body></html>", async () => {
  const html = streamOf(["<!DOCTYPE html><html><head></head><body><main>hi</main>", "</body></html>"]);
  const rsc = streamOf(['0:{"a":"</script>"}\n']);
  const out = await text(injectPayload(html, rsc));
  assert.ok(out.startsWith("<!DOCTYPE html><html><head></head><body><main>hi</main>"));
  assert.ok(out.endsWith("</body></html>"));
  assert.match(out, /<script>\(self\.__VINEXT_RSC__\|\|=\[\]\)\.push\(/);
  assert.ok(!out.includes('"</script>"'), "payload cannot close the script tag");
  const pushed = [...out.matchAll(/\.push\((".*?")\)<\/script>/g)].map((m) => JSON.parse(m[1])).join("");
  assert.equal(pushed, '0:{"a":"</script>"}\n');
});

test("notFound/forbidden/redirect throw errors recognised by digest", () => {
  const caught = (fn) => {
    try {
      fn();
    } catch (e) {
      return e;
    }
    assert.fail("expected a throw");
  };
  assert.equal(httpFallbackStatus(caught(notFound)), 404);
  assert.equal(httpFallbackStatus(caught(forbidden)), 403);
  assert.deepEqual(redirectInfo(caught(() => redirect("/a;b?x=1"))), { url: "/a;b?x=1", type: "replace", status: 307 });
  assert.equal(redirectInfo(caught(() => permanentRedirect("/p"))).status, 308);
  assert.equal(isNavigationError(new Error("boom")), false);
  assert.equal(httpFallbackStatus(caught(() => redirect("/x"))), null);
});

test("the app manifest lists routes and a loader for every file they name", () => {
  const src = generateAppManifest("/app/app", [
    "layout.tsx",
    "page.tsx",
    "not-found.tsx",
    "blog/[slug]/page.tsx",
    "blog/[slug]/layout.tsx",
    "components/counter.tsx",
  ]);
  assert.match(src, /export const routes = \[/);
  assert.match(src, /"blog\/\[slug\]\/layout.tsx": \(\) => import\("\/app\/app\/blog\/\[slug\]\/layout.tsx"\)/);
  assert.match(src, /"not-found.tsx": \(\) => import/);
  assert.ok(!src.includes("counter.tsx"), "plain modules get no loader");
});
