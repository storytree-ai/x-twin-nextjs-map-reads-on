import { test } from "node:test";
import assert from "node:assert/strict";
import { staticParamsAllow } from "../src/server/app-router/segment-config.js";

test("dynamicParams = false allows only the params generateStaticParams returns", async () => {
  const page = { dynamicParams: false, generateStaticParams: async () => [{ id: "1" }, { id: "2" }] };
  assert.equal(await staticParamsAllow([null, page], { id: "1" }), true);
  assert.equal(await staticParamsAllow([null, page], { id: "999" }), false);
  // With nothing generated, no params render.
  assert.equal(await staticParamsAllow([{ dynamicParams: false }, {}], { id: "1" }), false);
  // Without dynamicParams = false, any params render.
  assert.equal(await staticParamsAllow([null, { generateStaticParams: page.generateStaticParams }], { id: "999" }), true);
});

test("a child's generateStaticParams runs for each of its parent's params; catch-alls compare as arrays", async () => {
  const layout = { dynamicParams: false, generateStaticParams: async () => [{ lang: "en" }, { lang: "fr" }] };
  const seen = [];
  const page = {
    generateStaticParams: async ({ params }) => {
      seen.push(params.lang);
      return [{ slug: [params.lang, "a"] }];
    },
  };
  assert.equal(await staticParamsAllow([layout, page], { lang: "fr", slug: ["fr", "a"] }), true);
  assert.deepEqual(seen, ["en", "fr"]);
  assert.equal(await staticParamsAllow([layout, page], { lang: "fr", slug: ["en", "a"] }), false);
  assert.equal(await staticParamsAllow([layout, page], { lang: "de", slug: ["de", "a"] }), false);
});

test("under dynamicParams = false a segment nothing generates allows no value", async () => {
  const layout = { dynamicParams: false, generateStaticParams: async () => [{ lang: "en" }] };
  assert.equal(await staticParamsAllow([layout, {}], { lang: "en", slug: "anything" }), false);
  assert.equal(await staticParamsAllow([layout, {}], { lang: "en" }), true);
});

test("generateStaticParams runs once for the same modules", async () => {
  let calls = 0;
  const page = { dynamicParams: false, generateStaticParams: async () => (calls++, [{ id: "1" }]) };
  await staticParamsAllow([null, page], { id: "1" });
  await staticParamsAllow([null, page], { id: "2" });
  assert.equal(calls, 1);
  // A new module (an edit) generates again.
  await staticParamsAllow([null, { ...page }], { id: "1" });
  assert.equal(calls, 2);
});
