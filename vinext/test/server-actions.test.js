import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequestContext, runWithRequestContext } from "../src/shims/internal/request-context.js";
import { cookies } from "../src/shims/headers.js";
import { revalidatePath, revalidateTag } from "../src/shims/cache.js";
import { redirect, redirectInfo } from "../src/shims/internal/navigation-errors.js";
import { actionRequestKind, runServerAction, endActionPhase } from "../src/server/app-router/actions.js";
import { formSubmitUrl } from "../src/shims/internal/form-url.js";

/** Stand-ins for @vitejs/plugin-rsc's decoders: actions by id, args passed through. */
function fakeRsc(actions) {
  return {
    createTemporaryReferenceSet: () => ({ temp: true }),
    async decodeReply(body) {
      return typeof body === "string" ? JSON.parse(body) : [body];
    },
    async loadServerAction(id) {
      // Like plugin-rsc: a known module with no such export loads as undefined.
      if (id.startsWith("known-module#")) return undefined;
      if (!actions[id]) throw new Error(`unknown action ${id}`);
      return actions[id];
    },
    async decodeAction(formData) {
      const key = [...formData.keys()].find((k) => k.startsWith("$ACTION_ID_"));
      if (!key) return null;
      const fn = actions[key.slice("$ACTION_ID_".length)];
      return () => fn(formData);
    },
    async decodeFormState(result) {
      return [result, "k", "id", 0];
    },
  };
}

function actionRequest(id, args, headers = {}) {
  return new Request("http://localhost/page", {
    method: "POST",
    headers: { "x-rsc-action": id, "content-type": "text/plain;charset=UTF-8", ...headers },
    body: JSON.stringify(args),
  });
}

async function inAction(request, fn) {
  const ctx = createRequestContext(request, { phase: "action" });
  return runWithRequestContext(ctx, () => fn(ctx));
}

test("POSTs carrying an action are told apart from other requests", () => {
  assert.equal(actionRequestKind(actionRequest("a", [])), "fetch");
  const form = new FormData();
  form.set("$ACTION_ID_a", "");
  assert.equal(actionRequestKind(new Request("http://localhost/", { method: "POST", body: form })), "form");
  assert.equal(actionRequestKind(new Request("http://localhost/")), null);
  assert.equal(actionRequestKind(new Request("http://localhost/", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })), null);
});

test("a client call runs the action with its arguments and returns its value", async () => {
  const rsc = fakeRsc({ add: async (a, b) => a + b });
  const result = await inAction(actionRequest("add", [2, 3]), (ctx) => runServerAction(ctx, rsc));
  assert.equal(result.kind, "fetch");
  assert.deepEqual(result.returnValue, { ok: true, data: 5 });
  assert.deepEqual(result.temporaryReferences, { temp: true });
});

test("an action's error is returned to the caller, an unknown action is not found", async () => {
  const rsc = fakeRsc({ fail: async () => Promise.reject(new Error("nope")) });
  const failed = await inAction(actionRequest("fail", []), (ctx) => runServerAction(ctx, rsc));
  assert.equal(failed.returnValue.ok, false);
  assert.equal(failed.returnValue.data.message, "nope");
  const unknown = await inAction(actionRequest("missing", []), (ctx) => runServerAction(ctx, rsc));
  assert.equal(unknown.notFound, true);
  const noExport = await inAction(actionRequest("known-module#missing", []), (ctx) => runServerAction(ctx, rsc));
  assert.equal(noExport.notFound, true, "a module without the named export is not found either");
});

test("redirect() in an action is a push redirect, its cookies kept", async () => {
  const rsc = fakeRsc({
    go: async () => {
      (await cookies()).set("seen", "1");
      redirect("/about");
    },
  });
  const result = await inAction(actionRequest("go", []), async (ctx) => {
    const out = await runServerAction(ctx, rsc);
    assert.match(ctx.setCookieHeaders.getSetCookie()[0], /^seen=1/);
    return out;
  });
  assert.deepEqual(result.redirect, { url: "/about", type: "push", status: 307 });
  const outside = (() => {
    try {
      redirect("/x");
    } catch (e) {
      return redirectInfo(e);
    }
  })();
  assert.equal(outside.type, "replace", "outside an action redirect() replaces");
});

test("cookies an action sets reach the re-render, which cannot write them", async () => {
  const rsc = fakeRsc({ set: async () => (await cookies()).set("action-cookie", "from-action", { path: "/" }) });
  await inAction(actionRequest("set", []), async (ctx) => {
    await runServerAction(ctx, rsc);
    assert.equal(endActionPhase(ctx), true, "a cookie write re-renders the page");
    assert.equal(ctx.phase, "render");
    const store = await cookies();
    assert.equal(store.get("action-cookie").value, "from-action");
    assert.throws(() => store.set("action-cookie", "render-write"), /Cookies can only be modified in a Server Action/);
  });
});

test("revalidatePath and revalidateTag in an action re-render the page; a plain action does not", async () => {
  const rsc = fakeRsc({
    plain: async () => 1,
    path: async () => revalidatePath("/x"),
    tag: async () => revalidateTag("posts"),
  });
  for (const [id, rerender] of [["plain", false], ["path", true], ["tag", true]]) {
    await inAction(actionRequest(id, []), async (ctx) => {
      await runServerAction(ctx, rsc);
      assert.equal(endActionPhase(ctx), rerender, id);
    });
  }
});

test("a form post runs its action with the FormData and decodes the form state", async () => {
  const seen = [];
  const rsc = fakeRsc({ save: async (formData) => (seen.push(formData.get("name")), "saved") });
  const form = new FormData();
  form.set("$ACTION_ID_save", "");
  form.set("name", "ada");
  const result = await inAction(new Request("http://localhost/page", { method: "POST", body: form }), (ctx) => runServerAction(ctx, rsc));
  assert.deepEqual(seen, ["ada"]);
  assert.equal(result.kind, "form");
  assert.deepEqual(result.formState, ["saved", "k", "id", 0]);
});

test("a form post that names no action runs nothing", async () => {
  const form = new FormData();
  form.set("name", "ada");
  const result = await inAction(new Request("http://localhost/page", { method: "POST", body: form }), (ctx) =>
    runServerAction(ctx, fakeRsc({})),
  );
  assert.equal(result.kind, "form");
  assert.equal(result.formState, undefined);
  assert.equal(result.redirect, undefined);
});

test("next/form builds a GET submission's URL from the action and fields, the submitter's included", () => {
  const base = "http://localhost/search?old=1";
  const fields = [
    ["lang", "en"],
    ["q", "react"],
  ];
  assert.equal(formSubmitUrl({ action: "/search", fields, base }), "/search?lang=en&q=react");
  assert.equal(
    formSubmitUrl({ action: "/search", submitter: { formAction: "/search-alt" }, fields: [...fields, ["source", "s"]], base }),
    "/search-alt?lang=en&q=react&source=s",
  );
  assert.equal(formSubmitUrl({ action: "/search", method: "post", fields, base }), null, "POST forms submit natively");
  assert.equal(
    formSubmitUrl({ action: "/search", method: "post", submitter: { formAction: "/alt", formMethod: "get" }, fields, base }),
    "/alt?lang=en&q=react",
    "a GET submitter overrides a POST form",
  );
  assert.equal(formSubmitUrl({ action: "/search", target: "_blank", fields, base }), null);
  assert.equal(formSubmitUrl({ action: "https://other.test/x", fields, base }), null, "other origins submit natively");
  assert.equal(formSubmitUrl({ action: "/up", fields: [["f", new Blob(["x"])]], base }), null, "files submit natively");
});
