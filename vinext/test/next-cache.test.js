import { test } from "node:test";
import assert from "node:assert/strict";
import {
  unstable_cache,
  revalidateTag,
  revalidatePath,
  cacheLife,
  cacheTag,
} from "../src/shims/cache.js";
import { useCache, resetDataCache } from "../src/shims/internal/data-cache.js";
import { cachedFetch } from "../src/shims/internal/fetch-cache.js";
import { transformUseCache } from "../src/plugin/use-cache.js";
import { createRequestContext, runWithRequestContext } from "../src/shims/internal/request-context.js";

let counter = 0;
const tick = () => ++counter;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("unstable_cache returns one value per key and arguments", async () => {
  resetDataCache();
  const get = unstable_cache(async (n) => ({ n, v: tick() }), ["uc-a"], { tags: ["uc-tag"] });
  const a1 = await get(1);
  const a2 = await get(1);
  const b = await get(2);
  assert.equal(a2.v, a1.v);
  assert.notEqual(b.v, a1.v);
  const sameKeys = unstable_cache(async (n) => ({ n, v: -1 }), ["uc-a"]);
  assert.equal((await sameKeys(1)).v, -1, "a different function with the same keyParts has its own entries");
  const other = unstable_cache(async () => tick(), ["uc-b"]);
  assert.notEqual(await other(), await get(1).then((x) => x.v));
});

test("unstable_cache runs again after revalidateTag or its revalidate time", async () => {
  resetDataCache();
  const tagged = unstable_cache(async () => tick(), ["uc-tagged"], { tags: ["data"] });
  const first = await tagged();
  assert.equal(await tagged(), first);
  revalidateTag("data");
  const second = await tagged();
  assert.notEqual(second, first);
  assert.equal(await tagged(), second);

  const timed = unstable_cache(async () => tick(), ["uc-timed"], { revalidate: 0.05 });
  const t1 = await timed();
  assert.equal(await timed(), t1);
  await sleep(80);
  assert.notEqual(await timed(), t1);
});

test("a failing unstable_cache call is not cached", async () => {
  resetDataCache();
  let fail = true;
  const get = unstable_cache(async () => {
    if (fail) throw new Error("boom");
    return "ok";
  }, ["uc-fail"]);
  await assert.rejects(get(), /boom/);
  fail = false;
  assert.equal(await get(), "ok");
});

test("useCache keys by id and arguments and honours cacheLife and cacheTag", async () => {
  resetDataCache();
  const fn = async (x) => {
    cacheLife({ revalidate: 0.05 });
    cacheTag("uc-fn");
    return { x, v: tick() };
  };
  const call = (x) => useCache("mod#fn", fn, [x]);
  const a = await call("a");
  assert.equal((await call("a")).v, a.v);
  assert.notEqual((await call("b")).v, a.v);
  revalidateTag("uc-fn");
  const a2 = await call("a");
  assert.notEqual(a2.v, a.v);
  await sleep(80);
  assert.notEqual((await call("a")).v, a2.v);
});

test("cacheLife profiles set the revalidate time", async () => {
  resetDataCache();
  const fn = async () => {
    cacheLife("seconds");
    return tick();
  };
  const v = await useCache("mod#seconds", fn, []);
  assert.equal(await useCache("mod#seconds", fn, []), v);
  await sleep(1100);
  assert.notEqual(await useCache("mod#seconds", fn, []), v);
});

test("revalidatePath drops cache entries made while rendering that path", async () => {
  resetDataCache();
  const fn = async () => tick();
  const render = (pathname) =>
    runWithRequestContext(createRequestContext(new Request(`http://x.test${pathname}`)), () => useCache("mod#path", fn, [pathname]));
  const a = await render("/a");
  const b = await render("/b");
  assert.equal(await render("/a"), a);
  revalidatePath("/a");
  assert.notEqual(await render("/a"), a);
  assert.equal(await render("/b"), b);
  revalidatePath("/", "layout");
  assert.notEqual(await render("/b"), b);
});

test("tags used while rendering are recorded on the request", async () => {
  resetDataCache();
  const ctx = createRequestContext(new Request("http://x.test/p"));
  await runWithRequestContext(ctx, async () => {
    await unstable_cache(async () => 1, ["uc-rec"], { tags: ["t1"] })();
    await useCache("mod#rec", async () => {
      cacheTag("t2");
      return 2;
    }, []);
  });
  assert.deepEqual([...ctx.cacheTags].sort(), ["t1", "t2"]);
});

test("cached fetch answers repeat force-cache and next.revalidate GETs from the cache", async () => {
  resetDataCache();
  let calls = 0;
  const base = async () => new Response(`body-${++calls}`, { headers: { "x-n": String(calls) } });
  const fetch = cachedFetch(base);
  assert.equal(await (await fetch("http://x.test/a", { cache: "force-cache" })).text(), "body-1");
  const again = await fetch("http://x.test/a", { cache: "force-cache" });
  assert.equal(again.headers.get("x-n"), "1");
  assert.equal(await again.text(), "body-1");
  assert.equal(await (await fetch("http://x.test/b", { next: { revalidate: 60, tags: ["f"] } })).text(), "body-2");
  assert.equal(await (await fetch("http://x.test/b", { next: { revalidate: 60, tags: ["f"] } })).text(), "body-2");
  revalidateTag("f");
  assert.equal(await (await fetch("http://x.test/b", { next: { revalidate: 60, tags: ["f"] } })).text(), "body-3");
  assert.equal(await (await fetch("http://x.test/a")).text(), "body-4");
  const failing = cachedFetch(async () => new Response(`fail-${++calls}`, { status: 500 }));
  assert.equal(await (await failing("http://x.test/e", { cache: "force-cache" })).text(), "fail-5");
  assert.equal(await (await failing("http://x.test/e", { cache: "force-cache" })).text(), "fail-6");
  assert.equal(await (await fetch("http://x.test/a", { method: "POST", cache: "force-cache" })).text(), "body-7");
});

test("a no-store fetch marks the render dynamic", async () => {
  const fetch = cachedFetch(async () => new Response("x"));
  const ctx = createRequestContext(new Request("http://x.test/"));
  await runWithRequestContext(ctx, () => fetch("http://x.test/a", { cache: "no-store" }));
  assert.equal(ctx.dynamic, true);
});

test("transformUseCache wraps functions whose body starts with 'use cache'", async () => {
  const code = [
    "import { useCache } from 'vinext/use-cache-runtime';",
    "async function getData(a, b) {",
    '  "use cache";',
    "  return { sum: a + b, n: globalThis.__n = (globalThis.__n || 0) + 1 };",
    "}",
    "const arrow = async (x) => {",
    "  'use cache';",
    "  return { x, n: globalThis.__n = (globalThis.__n || 0) + 1 };",
    "};",
    "const byId = async ({ id }, [first] = []) => {",
    "  'use cache';",
    "  return { id, first, n: globalThis.__n = (globalThis.__n || 0) + 1 };",
    "};",
    "function plain() { const s = '{ \"use cache\" }'; return s; }",
    "if (true) { 'use cache'; }",
    "export { getData, arrow, byId, plain };",
  ].join("\n");
  const out = transformUseCache(code, "/app/lib/data.js");
  assert.ok(out, "the module is transformed");
  assert.match(out, /__vinext_useCache/);
  const mod = await importCode(out);
  resetDataCache();
  const r1 = await mod.getData(1, 2);
  assert.equal(r1.sum, 3);
  assert.equal((await mod.getData(1, 2)).n, r1.n);
  assert.notEqual((await mod.getData(2, 2)).n, r1.n);
  const x1 = await mod.arrow("q");
  assert.equal((await mod.arrow("q")).n, x1.n);
  const id1 = await mod.byId({ id: 1 }, ["a"]);
  assert.equal((await mod.byId({ id: 1 }, ["a"])).n, id1.n);
  assert.equal(id1.first, "a");
  assert.notEqual((await mod.byId({ id: 2 }, ["a"])).n, id1.n);
  assert.notEqual((await mod.byId({ id: 1 }, ["b"])).n, id1.n);
  assert.equal(mod.plain(), '{ "use cache" }');
});

test("transformUseCache wraps every exported function of a 'use cache' file", async () => {
  const code = [
    '"use cache";',
    "let n = 0;",
    "export default async function Page(props) { return { id: props.id, n: ++n }; }",
    "export async function helper() { return ++n; }",
    "export const other = async () => { return ++n; };",
    "async function listed(x) { return ++n; }",
    "const named = async () => { return ++n; };",
    "function local() { return ++n; }",
    "export { listed, named as renamed };",
  ].join("\n");
  const out = transformUseCache(code, "/app/page.js");
  const mod = await importCode(out);
  resetDataCache();
  const p = await mod.default({ id: "a" });
  assert.equal((await mod.default({ id: "a" })).n, p.n);
  const h = await mod.helper();
  assert.equal(await mod.helper(), h);
  const o = await mod.other();
  assert.equal(await mod.other(), o);
  const l = await mod.listed(1);
  assert.equal(await mod.listed(1), l);
  const r = await mod.renamed();
  assert.equal(await mod.renamed(), r);
});

test("export default of a local function in a 'use cache' file is cached", async () => {
  const code = ['"use cache"', "let n = 0;", "async function Page() { return ++n; }", "export default Page;"].join("\n");
  const mod = await importCode(transformUseCache(code, "/app/default.js"));
  resetDataCache();
  const v = await mod.default();
  assert.equal(await mod.default(), v);
});

test("transformUseCache leaves modules without the directive alone", () => {
  assert.equal(transformUseCache("export const a = 'use cache';", "/a.js"), null);
  assert.equal(transformUseCache("export function f() { return 1; }", "/a.js"), null);
});

const DATA_CACHE = new URL("../src/shims/internal/data-cache.js", import.meta.url).href;

async function importCode(code) {
  const src = code.replace(/["']vinext\/use-cache-runtime["']/g, JSON.stringify(DATA_CACHE));
  return import(`data:text/javascript;base64,${Buffer.from(src).toString("base64")}#${Math.random()}`);
}
