/**
 * app/ route.ts handlers: method dispatch (HEAD from GET, automatic OPTIONS,
 * 405), a NextRequest and params for the handler, next/headers in scope,
 * thrown notFound()/redirect() as statuses, and revalidate Cache-Control.
 */
import { NextRequest } from "../../shims/server.js";
import {
  createRequestContext,
  runWithRequestContext,
  applyResponseCookies,
  scheduleAfter,
} from "../../shims/internal/request-context.js";
import { httpFallbackStatus, redirectInfo } from "../../shims/internal/navigation-errors.js";

export const ROUTE_METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];
// Reading any of these makes a GET handler's response request-specific.
const DYNAMIC_REQUEST_MEMBERS = new Set(["headers", "url", "nextUrl", "cookies", "body", "json", "text", "formData", "arrayBuffer", "blob", "bytes"]);

/** Params as Next.js 15 passes them: a promise that also has the values as properties. */
function thenable(value) {
  return Object.assign(Promise.resolve(value), value);
}

/** A NextRequest whose request-specific members mark the handler dynamic when read. */
function trackedRequest(request, ctx) {
  const nextRequest = request instanceof NextRequest ? request : new NextRequest(request);
  return new Proxy(nextRequest, {
    get(target, prop) {
      if (DYNAMIC_REQUEST_MEMBERS.has(prop)) ctx.dynamic = true;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The Cache-Control a route module's segment config gives a fresh response, or null. */
export function routeCacheControl(mod, method, dynamic) {
  if (method !== "GET" || dynamic) return null;
  if (mod.dynamic === "force-dynamic") return null;
  const revalidate = mod.revalidate;
  if (typeof revalidate !== "number" || !(revalidate > 0) || revalidate === Infinity) return null;
  return `s-maxage=${revalidate}, stale-while-revalidate`;
}

function allowedMethods(mod) {
  const allow = new Set(ROUTE_METHODS.filter((m) => typeof mod[m] === "function"));
  if (allow.has("GET")) allow.add("HEAD");
  allow.add("OPTIONS");
  return [...allow].sort();
}

/** Call the route module's handler for the request. Always resolves to a Response. */
export async function callRouteHandler(mod, request, params, { file = "route" } = {}) {
  const method = request.method.toUpperCase();
  let handler = typeof mod[method] === "function" ? mod[method] : null;
  if (!handler && method === "HEAD" && typeof mod.GET === "function") handler = mod.GET;
  if (!handler && method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { Allow: allowedMethods(mod).join(", ") } });
  }
  if (!handler) return new Response(null, { status: 405 });

  const ctx = createRequestContext(request, { phase: "route", segmentConfig: mod });
  return runWithRequestContext(ctx, async () => {
    let response;
    try {
      response = await handler(trackedRequest(request, ctx), { params: thenable(params) });
      if (!(response instanceof Response)) {
        throw new Error(`[vinext] route handler app/${file} ${method} did not return a Response`);
      }
    } catch (error) {
      const redirect = redirectInfo(error);
      const status = httpFallbackStatus(error);
      if (redirect) response = new Response(null, { status: redirect.status, headers: { Location: redirect.url } });
      else if (status !== null) response = new Response(null, { status });
      else {
        console.error(error);
        response = new Response(null, { status: 500 });
      }
    }
    response = applyResponseCookies(ctx, response);
    const cacheControl = routeCacheControl(mod, method, ctx.dynamic);
    if (cacheControl && !response.headers.has("cache-control")) {
      try {
        response.headers.set("cache-control", cacheControl);
      } catch {
        response = new Response(response.body, response);
        response.headers.set("cache-control", cacheControl);
      }
    }
    if (method === "HEAD") response = new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
    return scheduleAfter(ctx, response);
  });
}
