/**
 * The front of the request pipeline on a Node request, in Next.js's order:
 * next.config headers (matched on the original request), redirects,
 * middleware, then beforeFiles rewrites. The caller routes the result and
 * applies afterFiles and fallback rewrites around its filesystem match.
 */
import { NextRequest, NextFetchEvent } from "../shims/server.js";
import { collectHeaders, findRedirect, findRewrite, matchesMiddleware } from "./request-pipeline.js";

const MIDDLEWARE_HEADER_RE = /^x-middleware-/;

/** A Node request's headers as Headers (HTTP/2 pseudo-headers left out). */
export function nodeHeaders(req) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || key.startsWith(":")) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, String(value));
  }
  return headers;
}

function addHeader(res, key, value) {
  const lower = key.toLowerCase();
  const existing = res.getHeader(lower);
  if (lower === "set-cookie") {
    res.setHeader(lower, [...(existing === undefined ? [] : [].concat(existing)), value]);
  } else if (lower === "vary" && existing !== undefined) {
    res.setHeader(key, `${existing}, ${value}`);
  } else {
    res.setHeader(key, value);
  }
}

/** Copy a middleware response's headers to res, leaving out its x-middleware-* signals. */
function copyResponseHeaders(from, res, { skipLength = false } = {}) {
  for (const cookie of from.getSetCookie()) addHeader(res, "set-cookie", cookie);
  for (const [key, value] of from) {
    if (key === "set-cookie" || MIDDLEWARE_HEADER_RE.test(key)) continue;
    if (skipLength && (key === "content-length" || key === "transfer-encoding")) continue;
    res.setHeader(key, value);
  }
}

/** A same-origin URL as a path; anything else as is. */
function relativeTo(href, origin) {
  const url = new URL(href, origin);
  return url.origin === origin ? url.pathname + url.search + url.hash : url.href;
}

function sendRedirect(res, destination, status, isData) {
  if (isData) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ redirect: { destination, status } }));
    return;
  }
  res.statusCode = status;
  res.setHeader("Location", destination);
  res.end();
}

async function sendWebResponse(res, response, { decoded = false } = {}) {
  res.statusCode = response.status;
  if (response.statusText) res.statusMessage = response.statusText;
  copyResponseHeaders(response.headers, res, { skipLength: true });
  // fetch() has already decompressed a proxied body.
  if (decoded) res.removeHeader("content-encoding");
  const body = response.body ? Buffer.from(await response.arrayBuffer()) : null;
  if (body) res.setHeader("Content-Length", body.length);
  res.end(body);
}

/** Replace the Node request's headers with middleware's `request.headers` override. */
function applyRequestOverride(req, response, headers) {
  const list = response.headers.get("x-middleware-override-headers");
  if (list === null) return headers;
  const next = new Headers();
  for (const name of list ? list.split(",") : []) {
    const value = response.headers.get(`x-middleware-request-${name}`);
    if (value !== null) next.set(name, value);
  }
  for (const key of Object.keys(req.headers)) {
    if (!next.has(key)) delete req.headers[key];
  }
  for (const [key, value] of next) req.headers[key] = value;
  return next;
}

async function proxy(res, req, target, headers) {
  const init = { method: req.method, headers, redirect: "manual" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req;
    init.duplex = "half";
  }
  headers.delete("host");
  await sendWebResponse(res, await fetch(target, init), { decoded: true });
}

/**
 * Run headers, redirects, middleware and beforeFiles rewrites for a request
 * whose logical path is `pathname`. Returns { url, headers } (url possibly
 * rewritten, headers as middleware left them), or null once it has answered.
 */
export async function runRequestPipeline(req, res, { pathname, search, isData, config, loadMiddleware }) {
  const origin = `http://${req.headers.host || "localhost"}`;
  let request = { url: new URL(pathname + search, origin), headers: nodeHeaders(req) };

  for (const { key, value } of collectHeaders(config.headers, request)) addHeader(res, key, value);

  const redirect = findRedirect(config.redirects, request);
  if (redirect) {
    sendRedirect(res, redirect.destination, redirect.status, isData);
    return null;
  }

  const mod = loadMiddleware ? await loadMiddleware() : null;
  const middleware = mod && (mod.middleware || mod.proxy || mod.default);
  if (typeof middleware === "function" && matchesMiddleware(mod.config, request)) {
    const nextRequest = new NextRequest(request.url.href, { method: req.method, headers: request.headers });
    let response;
    const event = new NextFetchEvent(nextRequest);
    try {
      response = await middleware(nextRequest, event);
    } catch (err) {
      console.error(err);
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Internal Server Error");
      return null;
    }
    for (const p of event._promises) Promise.resolve(p).catch((err) => console.error(err));
    if (response) {
      const rewrite = response.headers.get("x-middleware-rewrite");
      const next = response.headers.get("x-middleware-next") === "1";
      const location = response.headers.get("location");
      if (!rewrite && !next) {
        if (location && response.status >= 300 && response.status < 400) {
          copyResponseHeaders(response.headers, res, { skipLength: true });
          if (isData) res.removeHeader("location");
          sendRedirect(res, relativeTo(location, origin), response.status, isData);
        } else {
          await sendWebResponse(res, response);
        }
        return null;
      }
      copyResponseHeaders(response.headers, res, { skipLength: true });
      const headers = applyRequestOverride(req, response, request.headers);
      request = { url: request.url, headers };
      if (rewrite) {
        const target = new URL(rewrite, request.url);
        if (target.origin !== origin) {
          await proxy(res, req, target, new Headers(headers));
          return null;
        }
        request = { url: target, headers };
      }
    }
  }

  const before = findRewrite(config.rewrites?.beforeFiles, request);
  if (before) {
    if (before.origin !== origin) {
      await proxy(res, req, before, new Headers(request.headers));
      return null;
    }
    request = { url: before, headers: request.headers };
  }
  return request;
}

/** Apply a rewrite list to a routed request; returns the new request, null for none, or false once proxied. */
export async function applyRewrites(req, res, rules, request) {
  const target = findRewrite(rules, request);
  if (!target) return null;
  if (target.origin !== request.url.origin) {
    await proxy(res, req, target, new Headers(request.headers));
    return false;
  }
  return { url: target, headers: request.headers };
}
