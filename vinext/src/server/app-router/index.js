/**
 * App Router seam for the dev and production servers: runs the request
 * pipeline (next.config headers, redirects, middleware, rewrites) once, then
 * the rsc environment's fetch handler for the routed request. A request
 * routed to a pages/ route is handed to the Pages Router.
 */
import { Readable } from "node:stream";
import { parseRscPath, rscUrl } from "../../shared/rsc-url.js";
import { runRequestPipeline, applyRewrites } from "../middleware-runner.js";

/** A web Request for a Node IncomingMessage, optionally at another URL and with other headers. */
export function toWebRequest(req, { url: target, headers: override } = {}) {
  const host = req.headers.host || "localhost";
  // Appended, not resolved: "//x/y" is a path here, not a protocol-relative URL.
  const url = target || new URL(`http://${host}${req.originalUrl || req.url || "/"}`);
  let headers = override;
  if (!headers) {
    headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.startsWith(":") || value === undefined) continue;
      if (Array.isArray(value)) for (const v of value) headers.append(key, v);
      else headers.set(key, value);
    }
  }
  const method = (req.method || "GET").toUpperCase();
  const init = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req);
    init.duplex = "half";
  }
  return new Request(url, init);
}

/**
 * Write a web Response to a Node ServerResponse, streaming its body. Its
 * headers win over those already set (config and middleware headers), its
 * cookies are added to theirs; `status` overrides its status.
 */
export async function writeWebResponse(response, res, { status } = {}) {
  res.statusCode = status ?? response.status;
  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const [key, value] of response.headers) {
    if (key === "set-cookie") continue;
    res.setHeader(key, value);
  }
  if (cookies.length) {
    const existing = res.getHeader("set-cookie");
    res.setHeader("set-cookie", [...(existing === undefined ? [] : [].concat(existing)), ...cookies]);
  }
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.on("close", () => reader.cancel().catch(() => {}));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!res.write(value)) await new Promise((resolve) => res.once("drain", resolve));
  }
  res.end();
}

/**
 * Whether the request is the App Router client's RSC fetch, which takes
 * redirects as a header; a browser loading an .rsc URL gets real redirects.
 */
function isClientRscFetch(req, isRsc) {
  return isRsc && (String(req.headers.accept || "").includes("text/x-component") || req.headers.rsc === "1");
}

/**
 * Route a request through the pipeline to an app/ route (or none: the rsc
 * entry renders the 404), Next.js's order: beforeFiles rewrites, routes that
 * are not dynamic, afterFiles rewrites, dynamic routes, fallback rewrites.
 * `entry` is the rsc entry module; `pagesRouteKind(pathname)` ("static",
 * "dynamic" or null) and `handlePages(req, res, url)` hand pages/ routes to the Pages Router, whose own
 * pipeline is skipped for a request routed here. `serveFile(pathname, req,
 * res, status)` answers for a public file (see server/static-files.js),
 * checked once beforeFiles rewrites have run.
 */
export async function handleAppRouterRequest(req, res, { entry, pagesRouteKind = () => null, handlePages, serveFile }) {
  const rawUrl = req.originalUrl || req.url || "/";
  const query = rawUrl.indexOf("?");
  const rawPath = query === -1 ? rawUrl : rawUrl.slice(0, query);
  const search = query === -1 ? "" : rawUrl.slice(query);
  const { pathname, isRsc } = parseRscPath(rawPath);
  if (entry.instrumentationReady) await entry.instrumentationReady();
  const config = entry.serverConfig || {};
  let request = await runRequestPipeline(req, res, {
    pathname,
    search,
    isData: false,
    isRsc: isClientRscFetch(req, isRsc),
    config,
    loadMiddleware: entry.loadMiddleware,
  });
  if (!request) return true;
  // A public file is looked up by the browser's path, ".rsc" and all, unless rewritten.
  const filePath = isRsc && request.url.pathname === pathname ? rawPath : request.url.pathname;
  if (serveFile && (await serveFile(filePath, req, res, request.status))) return true;

  // A static route of either router before a dynamic one; app/ first.
  const routeOf = (p) => {
    const app = entry.routeKind(p);
    const pages = pagesRouteKind(p);
    if (app === "static") return { pages: false, dynamic: false };
    if (pages === "static") return { pages: true, dynamic: false };
    if (app) return { pages: false, dynamic: true };
    return pages ? { pages: true, dynamic: true } : null;
  };
  let route = routeOf(request.url.pathname);
  if (!route || route.dynamic) {
    for (const phase of ["afterFiles", "fallback"]) {
      if (phase === "fallback" && route) break;
      const rewritten = await applyRewrites(req, res, config.rewrites?.[phase], request);
      if (rewritten === false) return true;
      if (rewritten) {
        request = rewritten;
        route = routeOf(request.url.pathname);
        if (route) break;
      }
    }
  }

  if (route?.pages) {
    if (isRsc) {
      res.statusCode = 200;
      res.setHeader("x-vinext-reload", "1");
      res.end();
      return true;
    }
    await handlePages(req, res, request.url);
    return true;
  }

  const url = new URL(request.url);
  if (isRsc) {
    const rsc = new URL(rscUrl(url.pathname + url.search), url);
    url.pathname = rsc.pathname;
  }
  const response = await entry.default(toWebRequest(req, { url, headers: request.headers }));
  await writeWebResponse(response, res, { status: request.status });
  return true;
}
