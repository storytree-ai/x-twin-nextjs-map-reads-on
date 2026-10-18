/**
 * App Router rsc environment entry: matches a request against the app/ route
 * table, renders the route's server component tree (layouts, templates,
 * boundaries, page) to an RSC stream, and answers with the RSC payload or,
 * through the ssr environment, with HTML. route.ts handlers answer directly.
 */
import { createElement, Fragment, Suspense } from "react";
import { renderToReadableStream } from "@vitejs/plugin-rsc/rsc";
import { routes, root, loaders } from "virtual:vinext-app-manifest";
import { matchAppRoute } from "../../routing/app-routes.js";
import { ErrorBoundary, HttpFallbackBoundary, RedirectBoundary, LayoutSegments } from "../../client/app-boundaries.js";
import { httpFallbackStatus, redirectInfo, isNavigationError } from "../../shims/internal/navigation-errors.js";
import { resolveMetadata, renderMetadata } from "./metadata.js";
import { parseRscPath } from "../../shared/rsc-url.js";

const HTTP_FALLBACK_FILE = { 404: "notFound", 403: "forbidden", 401: "unauthorized" };
const ROUTE_METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];

async function load(file) {
  if (!file) return null;
  const loader = loaders[file];
  if (!loader) throw new Error(`[vinext] no loader for app/${file}`);
  return loader();
}

/** Params as Next.js 15 passes them: a promise that also has the values as properties. */
function thenable(value) {
  return Object.assign(Promise.resolve(value), value);
}

function searchParamsObject(searchParams) {
  const out = {};
  for (const [key, value] of searchParams) {
    if (key in out) out[key] = Array.isArray(out[key]) ? [...out[key], value] : [out[key], value];
    else out[key] = value;
  }
  return out;
}

/** The params bound by levels 0..index (what that level's layout receives). */
function paramsUpTo(levels, index, params) {
  const out = {};
  for (let i = 0; i <= index; i++) {
    const name = levels[i].paramName;
    if (name && params[name] !== undefined) out[name] = params[name];
  }
  return out;
}

/** URL segments below level `index`, as useSelectedLayoutSegments reports them. */
function segmentsBelow(levels, index, params) {
  const out = [];
  for (let i = index + 1; i < levels.length; i++) {
    const { segment, paramName } = levels[i];
    if (/^\(.*\)$/.test(segment)) {
      out.push(segment);
      continue;
    }
    if (paramName) {
      const value = params[paramName];
      if (Array.isArray(value)) out.push(value.join("/"));
      else if (value !== undefined) out.push(value);
      continue;
    }
    out.push(segment);
  }
  return out;
}

const DefaultNotFound = () =>
  createElement(
    "div",
    { style: { fontFamily: "system-ui, sans-serif", textAlign: "center", marginTop: "20vh" } },
    createElement("h1", null, "404"),
    createElement("p", null, "This page could not be found."),
  );

function defaultFallback(status) {
  if (status === 404) return createElement(DefaultNotFound);
  const text = status === 403 ? "Forbidden" : "Unauthorized";
  return createElement("div", null, createElement("h1", null, String(status)), createElement("p", null, text));
}

/**
 * The element tree for a route, from the root layout down to `leaf`. Each
 * level wraps its children as Next.js does:
 * Layout > Template > ErrorBoundary > Suspense(loading) > HttpFallbackBoundary > children.
 * With `fallback` ({ level, element }), levels below `level` are dropped and
 * that level's children are the fallback element.
 */
async function buildTree(levels, params, leaf, { fallback, pathname } = {}) {
  const last = fallback ? fallback.level : levels.length - 1;
  const mods = await Promise.all(
    levels.slice(0, last + 1).map(async (level) => {
      const [layout, template, error, loading, notFound, forbidden, unauthorized] = await Promise.all(
        [level.layout, level.template, level.error, level.loading, level.notFound, level.forbidden, level.unauthorized].map(load),
      );
      return { layout, template, error, loading, notFound, forbidden, unauthorized };
    }),
  );
  let node = fallback ? fallback.element : leaf;
  for (let i = last; i >= 0; i--) {
    const level = levels[i];
    const mod = mods[i];
    if (!fallback && (mod.notFound || mod.forbidden || mod.unauthorized)) {
      node = createElement(HttpFallbackBoundary, {
        notFound: mod.notFound ? createElement(mod.notFound.default) : undefined,
        forbidden: mod.forbidden ? createElement(mod.forbidden.default) : undefined,
        unauthorized: mod.unauthorized ? createElement(mod.unauthorized.default) : undefined,
        children: node,
      });
    }
    if (!fallback && mod.loading) node = createElement(Suspense, { fallback: createElement(mod.loading.default) }, node);
    if (mod.error) node = createElement(ErrorBoundary, { errorComponent: mod.error.default }, node);
    if (mod.template) node = createElement(mod.template.default, { key: pathname }, node);
    if (mod.layout) {
      const segments = fallback ? [] : segmentsBelow(levels, i, params);
      node = createElement(
        mod.layout.default,
        { params: thenable(paramsUpTo(levels, i, params)) },
        createElement(LayoutSegments, { segments }, node),
      );
    }
  }
  return node;
}

async function pageElement(route, params, searchParams) {
  const mod = await load(route.file);
  const Page = mod.default;
  if (!Page) throw new Error(`[vinext] app/${route.file} has no default export`);
  return createElement(Page, { params: thenable(params), searchParams: thenable(searchParamsObject(searchParams)) });
}

async function headElements(levels, last, leafMod, params, searchParams) {
  const mods = await Promise.all(levels.slice(0, last + 1).map((l) => load(l.layout)));
  if (leafMod) mods.push(leafMod);
  const metadata = await resolveMetadata(mods.filter(Boolean), {
    params: thenable(params),
    searchParams: thenable(searchParamsObject(searchParams)),
  });
  return renderMetadata(metadata);
}

/** Root-level tree for URLs no route matches. */
async function notFoundTree(pathname) {
  const levels = [root];
  const mod = await load(root.notFound);
  const element = mod ? createElement(mod.default) : defaultFallback(404);
  const head = await headElements(levels, 0, null, {}, new URLSearchParams());
  const tree = await buildTree(levels, {}, null, { fallback: { level: 0, element: withHead(head, element) }, pathname });
  return root.layout ? tree : createElement("html", null, createElement("body", null, tree));
}

function withHead(head, node) {
  return createElement(Fragment, null, head, node);
}

/** The tree for a matched route, with its metadata. */
async function routeTree(match, url) {
  const { route, params } = match;
  const leaf = await pageElement(route, params, url.searchParams);
  const leafMod = await load(route.file);
  const head = await headElements(route.levels, route.levels.length - 1, leafMod, params, url.searchParams);
  return buildTree(route.levels, params, withHead(head, leaf), { pathname: url.pathname });
}

/** The tree rendering the nearest notFound/forbidden/unauthorized boundary inside the route's layouts. */
async function fallbackTree(match, url, status) {
  const { route, params } = match;
  const key = HTTP_FALLBACK_FILE[status];
  let level = route.levels.length - 1;
  while (level > 0 && !route.levels[level][key]) level--;
  const file = route.levels[level][key];
  const mod = await load(file);
  const element = mod ? createElement(mod.default) : defaultFallback(status);
  const head = await headElements(route.levels, level, null, params, url.searchParams);
  return buildTree(route.levels, params, null, { fallback: { level, element: withHead(head, element) }, pathname: url.pathname });
}

function payloadFor(tree, url, params) {
  return {
    tree: createElement(RedirectBoundary, null, tree),
    pathname: url.pathname,
    search: url.search,
    params,
  };
}

function rscOptions(errors) {
  return {
    onError(error) {
      if (error && typeof error === "object" && typeof error.digest === "string") {
        errors.push(error);
        return error.digest;
      }
      errors.push(error);
      if (!isNavigationError(error)) console.error(error);
      return undefined;
    },
  };
}

function rscResponse(stream, status, headers = {}) {
  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/x-component; charset=utf-8", Vary: "Accept", ...headers },
  });
}

function redirectResponse(info, isRsc) {
  if (isRsc) return new Response(null, { status: 200, headers: { "x-vinext-redirect": info.url } });
  return new Response(null, { status: info.status, headers: { Location: info.url } });
}

async function renderPage(url, isRsc, match) {
  let tree;
  let status = 200;
  try {
    tree = match ? await routeTree(match, url) : await notFoundTree(url.pathname);
    if (!match) status = 404;
  } catch (error) {
    // notFound()/redirect() thrown while loading modules or metadata.
    const redirect = redirectInfo(error);
    if (redirect) return redirectResponse(redirect, isRsc);
    const fallbackStatus = httpFallbackStatus(error);
    if (fallbackStatus === null || !match) throw error;
    tree = await fallbackTree(match, url, fallbackStatus);
    status = fallbackStatus;
  }
  const params = match ? match.params : {};
  const errors = [];
  const stream = renderToReadableStream(payloadFor(tree, url, params), rscOptions(errors));
  if (isRsc) return rscResponse(stream, status);

  const ssr = await import.meta.viteRsc.loadModule("ssr", "index");
  try {
    const html = await ssr.renderHtml(stream);
    return htmlResponse(html, status);
  } catch (error) {
    const redirect = redirectInfo(error);
    if (redirect) return redirectResponse(redirect, false);
    const fallbackStatus = httpFallbackStatus(error);
    if (fallbackStatus === null) throw error;
    const fallback = match ? await fallbackTree(match, url, fallbackStatus) : await notFoundTree(url.pathname);
    const html = await ssr.renderHtml(renderToReadableStream(payloadFor(fallback, url, params), rscOptions([])));
    return htmlResponse(html, fallbackStatus);
  }
}

function htmlResponse(stream, status) {
  return new Response(stream, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function handleRoute(request, match) {
  const mod = await load(match.route.file);
  let method = request.method.toUpperCase();
  let handler = typeof mod[method] === "function" ? mod[method] : null;
  if (!handler && method === "HEAD" && typeof mod.GET === "function") handler = mod.GET;
  if (!handler && method === "OPTIONS") {
    const allow = ROUTE_METHODS.filter((m) => typeof mod[m] === "function" || (m === "HEAD" && typeof mod.GET === "function"));
    if (!allow.includes("OPTIONS")) allow.push("OPTIONS");
    return new Response(null, { status: 204, headers: { Allow: allow.join(", ") } });
  }
  if (!handler) {
    const allow = ROUTE_METHODS.filter((m) => typeof mod[m] === "function");
    return new Response(null, { status: 405, headers: { Allow: allow.join(", ") } });
  }
  try {
    const response = await handler(request, { params: thenable(match.params) });
    if (!(response instanceof Response)) {
      throw new Error(`[vinext] route handler app/${match.route.file} ${method} did not return a Response`);
    }
    if (request.method.toUpperCase() === "HEAD") return new Response(null, { status: response.status, headers: response.headers });
    return response;
  } catch (error) {
    const redirect = redirectInfo(error);
    if (redirect) return new Response(null, { status: redirect.status, headers: { Location: redirect.url } });
    const status = httpFallbackStatus(error);
    if (status !== null) return new Response(null, { status });
    throw error;
  }
}

/** Whether a page pathname has an app/ route (pages/ handles the rest). */
export function hasRoute(pathname) {
  return matchAppRoute(routes, parseRscPath(pathname).pathname) !== null;
}

/** The fetch handler: a Request in, a Response out. */
export default async function handler(request) {
  const url = new URL(request.url);
  const { pathname, isRsc } = parseRscPath(url.pathname);
  const pageUrl = new URL(url);
  pageUrl.pathname = pathname;
  const match = matchAppRoute(routes, pathname);
  if (match && match.route.type === "route") {
    if (isRsc) return new Response(null, { status: 200, headers: { "x-vinext-reload": "1" } });
    return handleRoute(request, match);
  }
  return renderPage(pageUrl, isRsc || request.headers.get("rsc") === "1", match);
}

if (import.meta.hot) import.meta.hot.accept();
