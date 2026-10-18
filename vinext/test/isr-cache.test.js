import { test } from "node:test";
import assert from "node:assert/strict";
import { serveWithIsr, revalidateSeconds } from "../src/server/app-router/isr-cache.js";
import { revalidatePath, revalidateTag } from "../src/shims/cache.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function renderer(cacheControl = "s-maxage=1, stale-while-revalidate", tags = []) {
  let n = 0;
  const render = async () => {
    n++;
    return {
      response: new Response(`body-${n}`, { status: 200, headers: { "Content-Type": "text/html", "Cache-Control": cacheControl } }),
      tags,
    };
  };
  return { render, count: () => n };
}

test("revalidateSeconds reads s-maxage", () => {
  assert.equal(revalidateSeconds("s-maxage=60, stale-while-revalidate"), 60);
  assert.equal(revalidateSeconds("private, no-cache, no-store, max-age=0, must-revalidate"), null);
  assert.equal(revalidateSeconds(null), null);
});

test("an ISR page answers MISS, HIT, then STALE while it regenerates, then HIT", async () => {
  const { render, count } = renderer("s-maxage=0.05, stale-while-revalidate");
  const r1 = await serveWithIsr("html:/isr-a", render);
  assert.equal(r1.headers.get("x-vinext-cache"), "MISS");
  assert.equal(await r1.text(), "body-1");
  const r2 = await serveWithIsr("html:/isr-a", render);
  assert.equal(r2.headers.get("x-vinext-cache"), "HIT");
  assert.equal(r2.headers.get("cache-control"), "s-maxage=0.05, stale-while-revalidate");
  assert.equal(await r2.text(), "body-1");
  await sleep(80);
  const r3 = await serveWithIsr("html:/isr-a", render);
  assert.equal(r3.headers.get("x-vinext-cache"), "STALE");
  assert.equal(await r3.text(), "body-1");
  await sleep(10);
  assert.equal(count(), 2);
  const r4 = await serveWithIsr("html:/isr-a", render);
  assert.equal(r4.headers.get("x-vinext-cache"), "HIT");
  assert.equal(await r4.text(), "body-2");
});

test("pages that are not ISR pass through uncached", async () => {
  const { render, count } = renderer("private, no-cache, no-store, max-age=0, must-revalidate");
  const r1 = await serveWithIsr("html:/dyn", render);
  assert.equal(r1.headers.get("x-vinext-cache"), null);
  await serveWithIsr("html:/dyn", render);
  assert.equal(count(), 2);
  const notFound = async () => ({ response: new Response("nf", { status: 404, headers: { "Cache-Control": "s-maxage=5" } }), tags: [] });
  assert.equal((await serveWithIsr("html:/nf", notFound)).headers.get("x-vinext-cache"), null);
});

test("revalidatePath and revalidateTag drop ISR entries", async () => {
  const a = renderer("s-maxage=60, stale-while-revalidate", ["tag-a"]);
  await serveWithIsr("html:/isr-p", a.render);
  await serveWithIsr("rsc:/isr-p", a.render);
  assert.equal((await serveWithIsr("html:/isr-p", a.render)).headers.get("x-vinext-cache"), "HIT");
  revalidatePath("/isr-p");
  assert.equal((await serveWithIsr("html:/isr-p", a.render)).headers.get("x-vinext-cache"), "MISS");
  assert.equal((await serveWithIsr("rsc:/isr-p", a.render)).headers.get("x-vinext-cache"), "MISS");
  revalidateTag("other");
  assert.equal((await serveWithIsr("html:/isr-p", a.render)).headers.get("x-vinext-cache"), "HIT");
  revalidateTag("tag-a");
  assert.equal((await serveWithIsr("html:/isr-p", a.render)).headers.get("x-vinext-cache"), "MISS");
  revalidatePath("/", "layout");
  assert.equal((await serveWithIsr("html:/isr-p", a.render)).headers.get("x-vinext-cache"), "MISS");
});
