import { test } from "node:test";
import assert from "node:assert/strict";
import { createInstrumentation } from "../src/server/instrumentation.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("register() runs once, and has finished when ready() resolves", async () => {
  let calls = 0;
  let finished = false;
  const inst = createInstrumentation(async () => ({
    async register() {
      calls++;
      await tick();
      finished = true;
    },
  }));
  await Promise.all([inst.ready(), inst.ready()]);
  assert.equal(finished, true);
  await inst.ready();
  assert.equal(calls, 1);
});

test("onRequestError hears an error once, with the request and the route's context", async () => {
  const seen = [];
  const inst = createInstrumentation(async () => ({
    onRequestError: (error, request, context) => seen.push({ message: error.message, request, context }),
  }));
  await inst.ready();
  const request = new Request("http://localhost/api/boom.rsc?x=1", { method: "POST", headers: { "x-a": "1" } });
  const error = new Error("boom");
  inst.report(error, request, { file: "api/boom/route.ts", pattern: "/api/boom" }, "route");
  inst.report(error, request, { file: "api/boom/route.ts", pattern: "/api/boom" }, "route");
  await tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].message, "boom");
  assert.deepEqual(seen[0].request, { path: "/api/boom?x=1", method: "POST", headers: { "x-a": "1" } });
  assert.deepEqual(seen[0].context, { routerKind: "App Router", routePath: "/api/boom/route", routeType: "route" });
});

test("without instrumentation.ts, ready() resolves and reports go nowhere", async () => {
  const inst = createInstrumentation(null);
  await inst.ready();
  inst.report(new Error("x"), new Request("http://localhost/"), null, "render");
});

test("the same error thrown on two requests is reported for each", async () => {
  const seen = [];
  const inst = createInstrumentation(async () => ({ onRequestError: (_e, request) => seen.push(request.path) }));
  await inst.ready();
  const shared = new Error("cached rejection");
  const route = { file: "api/a/route.ts", pattern: "/api/a" };
  inst.report(shared, new Request("http://localhost/api/a?n=1"), route, "route");
  inst.report(shared, new Request("http://localhost/api/a?n=2"), route, "route");
  await tick();
  assert.deepEqual(seen, ["/api/a?n=1", "/api/a?n=2"]);
});
