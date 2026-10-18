/**
 * The per-request store behind next/headers and next/server's connection()
 * and after(): the request's headers and cookies, the cookies a handler or
 * action sets, whether the render used dynamic APIs, and deferred work.
 * One AsyncLocalStorage per process, found through globalThis, so every
 * module instance (Vite may load a shim more than once) shares it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { RequestCookies, ResponseCookies } from "./cookies.js";

const KEY = Symbol.for("vinext.requestContext");
const storage = (globalThis[KEY] ??= new AsyncLocalStorage());

/**
 * A context for one request. `phase` is "render" (server components: cookies
 * are read-only), "route" (route handlers) or "action" (server actions).
 */
export function createRequestContext(request, { phase = "render", segmentConfig = {} } = {}) {
  const requestHeaders = new Headers(request.headers);
  const setCookieHeaders = new Headers();
  return {
    request,
    phase,
    segmentConfig,
    headers: requestHeaders,
    cookies: new RequestCookies(requestHeaders),
    responseCookies: new ResponseCookies(setCookieHeaders),
    setCookieHeaders,
    dynamic: false,
    afterTasks: [],
  };
}

export function runWithRequestContext(ctx, fn) {
  return storage.run(ctx, fn);
}

export function getRequestContext() {
  return storage.getStore() || null;
}

/** Record that the current render read request-time data. */
export function markDynamic() {
  const ctx = storage.getStore();
  if (ctx) ctx.dynamic = true;
}

/** Copy the cookies the request set onto a response's headers. */
export function applyResponseCookies(ctx, response) {
  const cookies = ctx.setCookieHeaders.getSetCookie();
  if (!cookies.length) return response;
  let target = response;
  try {
    for (const c of cookies) target.headers.append("set-cookie", c);
  } catch {
    // Immutable headers (e.g. Response.redirect): copy into a new Response.
    target = new Response(response.body, response);
    for (const c of cookies) target.headers.append("set-cookie", c);
  }
  return target;
}

/** Queue after() work: a function to call, or a promise to wait for (its rejection is handled now). */
export function queueAfter(ctx, task) {
  if (task && typeof task.then === "function") {
    const settled = Promise.resolve(task);
    settled.catch(() => {});
    task = () => settled;
  }
  if (ctx) {
    ctx.afterTasks.push(task);
    return;
  }
  setTimeout(() => runAfterTask(task), 0);
}

function runAfterTask(task) {
  Promise.resolve()
    .then(() => (typeof task === "function" ? task() : undefined))
    .catch((err) => console.error("[vinext] after() callback failed:", err));
}

/**
 * Run the request's after() work once `response`'s body has been read to the
 * end (or now, for a bodiless response). Returns the response to send.
 */
export function scheduleAfter(ctx, response) {
  if (!ctx.afterTasks.length) return response;
  const run = () => {
    const tasks = ctx.afterTasks.splice(0);
    setTimeout(() => {
      runWithRequestContext(ctx, () => tasks.forEach(runAfterTask));
    }, 0);
  };
  if (!response.body) {
    run();
    return response;
  }
  const body = response.body.pipeThrough(
    new TransformStream({
      flush() {
        run();
      },
    }),
  );
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
