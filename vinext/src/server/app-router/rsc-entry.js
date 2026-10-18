/**
 * App Router rsc environment entry: matches a request against the app/ route
 * table, renders the route's server component tree (layouts, templates,
 * boundaries, page) to an RSC stream, and answers with the RSC payload or,
 * through the ssr environment, with HTML. route.ts handlers answer directly.
 */
import { createElement, Fragment, Suspense } from "react";
import {
  renderToReadableStream,
  createTemporaryReferenceSet,
  decodeReply,
  decodeAction,
  decodeFormState,
  loadServerAction,
} from "@vitejs/plugin-rsc/rsc";
import { routes, root, intercepts, loaders, loadMiddleware as middlewareLoader, loadInstrumentation } from "virtual:vinext-app-manifest";
import serverConfig from "virtual:vinext-server-config";
import { matchAppRoute, matchIntercept, nextErrorBoundary, selectSlot } from "../../routing/app-routes.js";
import { ErrorBoundary, HttpFallbackBoundary, RedirectBoundary, LayoutSegments } from "../../client/app-boundaries.js";
import { httpFallbackStatus, redirectInfo, isNavigationError, notFound } from "../../shims/internal/navigation-errors.js";
import { renderHead } from "./metadata.js";
import { metadataRouteResponse } from "./metadata-routes.js";
import { parseRscPath } from "../../shared/rsc-url.js";
import { callRouteHandler } from "./route-handler.js";
import { createInstrumentation } from "../instrumentation.js";
import { actionRequestKind, runServerAction, endActionPhase } from "./actions.js";
import { resolveSegmentConfig, finalizeCacheControl, staticParamsAllow, NO_STORE } from "./segment-config.js";
import { serveWithIsr } from "./isr-cache.js";
import { installFetchCache } from "../../shims/internal/fetch-cache.js";
import {
  createRequestContext,
  runWithRequestContext,
  getRequestContext,
  scheduleAfter,
  applyResponseCookies,
} from "../../shims/internal/request-context.js";

installFetchCache();

const HTTP_FALLBACK_FILE = { 404: "notFound", 403: "forbidden", 401: "unauthorized" };

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
 * that level's children are the fallback element. With `caught`
 * ({ level, serverError }), that level's error boundary starts showing the error.
 * Each layout also gets its @slots as props (`slots` overriding one with an
 * intercepting page: { level, name, element }, "children" cutting the levels
 * below). A slot's own levels are built the same way, `nested`.
 */
async function buildTree(levels, params, leaf, { fallback, pathname, caught, searchParams, slot, slotPathname, nested = false } = {}) {
  const cut = slot?.name === "children" ? slot.level : levels.length - 1;
  const last = fallback ? Math.min(fallback.level, cut) : cut;
  const mods = await Promise.all(
    levels.slice(0, last + 1).map(async (level, i) => {
      const [layout, template, error, loading, notFound, forbidden, unauthorized] = await Promise.all(
        [level.layout, level.template, level.error, level.loading, level.notFound, level.forbidden, level.unauthorized].map(load),
      );
      const slots = layout ? await slotProps(level, i, params, { pathname, searchParams, slot, slotPathname }) : {};
      return { layout, template, error, loading, notFound, forbidden, unauthorized, slots };
    }),
  );
  let node = fallback ? fallback.element : slot?.name === "children" ? slot.element : leaf;
  for (let i = last; i >= 0; i--) {
    const level = levels[i];
    const mod = mods[i];
    // The root level always has a boundary, with default fallbacks for missing files.
    if (!fallback && ((i === 0 && !nested) || mod.notFound || mod.forbidden || mod.unauthorized)) {
      const fallbackFor = (m, status) => (m ? createElement(m.default) : i === 0 && !nested ? defaultFallback(status) : undefined);
      node = createElement(HttpFallbackBoundary, {
        notFound: fallbackFor(mod.notFound, 404),
        forbidden: fallbackFor(mod.forbidden, 403),
        unauthorized: fallbackFor(mod.unauthorized, 401),
        children: node,
      });
    }
    if (!fallback && mod.loading) node = createElement(Suspense, { fallback: createElement(mod.loading.default) }, node);
    if (mod.error) {
      const serverError = caught?.level === i ? caught.serverError : undefined;
      node = createElement(ErrorBoundary, { errorComponent: mod.error.default, serverError }, node);
    }
    if (mod.template) node = createElement(mod.template.default, { key: pathname }, node);
    if (mod.layout) {
      const segments = fallback ? [] : segmentsBelow(levels, i, params);
      node = createElement(
        mod.layout.default,
        { ...mod.slots, params: thenable(paramsUpTo(levels, i, params)) },
        createElement(LayoutSegments, { segments }, node),
      );
    }
  }
  return node;
}

/**
 * The elements for a layout's @slot props: each slot's page for the URL
 * (`slotPathname`, else `pathname`) below the layout, or its default.tsx,
 * under the slot's levels.
 */
async function slotProps(level, index, params, { pathname, searchParams, slot, slotPathname }) {
  const out = {};
  const parts = (slotPathname ?? pathname ?? "/").split("/").filter(Boolean);
  for (const [name, candidates] of Object.entries(level.slots || {})) {
    if (slot && slot.level === index && slot.name === name) continue;
    const content = selectSlot(candidates, parts.slice(level.urlDepth));
    if (content) out[name] = await slotTree(content, { ...params, ...content.params }, { pathname, searchParams });
  }
  if (slot && slot.level === index && slot.name !== "children") out[slot.name] = slot.element;
  return out;
}

/** A slot's (or intercepting page's) tree: its page under its own layouts and boundaries. */
async function slotTree(content, params, { pathname, searchParams }) {
  const leaf = await pageElement(content, params, searchParams || new URLSearchParams());
  return buildTree(content.levels, params, leaf, { pathname, searchParams, nested: true });
}

async function pageElement(route, params, searchParams) {
  const mod = await load(route.file);
  const Page = mod.default;
  if (!Page) throw new Error(`[vinext] app/${route.file} has no default export`);
  return createElement(Page, { params: thenable(params), searchParams: thenable(searchParamsObject(searchParams)) });
}

async function headElements(levels, last, leafMod, params, url, { noindex = false } = {}) {
  return renderHead(levels, last, leafMod, {
    params,
    props: { params: thenable(params), searchParams: thenable(searchParamsObject(url.searchParams)) },
    origin: url.origin,
    load,
    noindex,
  });
}

/** Throws a metadata error where the page renders, for the segment's error boundary. */
function MetadataError({ error }) {
  throw error;
}

/** Root-level tree for URLs no route matches. */
async function notFoundTree(url, caught) {
  const levels = [root];
  const mod = await load(root.notFound);
  const element = mod ? createElement(mod.default) : defaultFallback(404);
  const head = await headElements(levels, 0, mod, {}, url, { noindex: true });
  const tree = await buildTree(levels, {}, null, { fallback: { level: 0, element: withHead(head, element) }, pathname: url.pathname, caught });
  return root.layout ? tree : createElement("html", null, createElement("body", null, tree));
}

/** global-error.tsx around the root layout, showing `caught`'s error when it is the boundary. */
async function withGlobalError(tree, caught) {
  const mod = await load(root.globalError);
  if (!mod) return tree;
  const serverError = caught?.level === -1 ? caught.serverError : undefined;
  return createElement(ErrorBoundary, { errorComponent: mod.default, serverError }, tree);
}

function withHead(head, node) {
  return createElement(Fragment, null, head, node);
}

/** The tree for a matched route, with its metadata. */
async function routeTree(match, url, caught) {
  const { route, params, intercept } = match;
  // dynamicParams = false: params generateStaticParams did not return are not found.
  if (intercept) {
    const { target } = intercept;
    const dynamic = intercept.intercept.segments.some((s) => s.value === undefined);
    if (dynamic && !(await staticParamsAllow(await interceptModules(intercept), intercept.params))) notFound();
    if (target?.route.isDynamic && !(await staticParamsAllow(await routeModules(target.route), target.params))) notFound();
  } else if (route.isDynamic && !(await staticParamsAllow(await routeModules(route), params))) notFound();
  const options = { pathname: url.pathname, searchParams: url.searchParams, caught, slotPathname: match.slotPathname };
  // A client navigation intercepted: the page the client is on, the
  // intercepting page in its slot of the intercepting layout.
  if (intercept) {
    const element = await slotTree(intercept.intercept, intercept.params, options);
    options.slot = { level: intercept.ownerIndex, name: intercept.intercept.slot, element };
  }
  const leaf = await pageElement(route, params, url.searchParams);
  const leafMod = await load(route.file);
  let head;
  try {
    head = await headElements(route.levels, route.levels.length - 1, leafMod, params, url);
  } catch (error) {
    // notFound()/redirect() from generateMetadata act as the page's own would.
    if (isNavigationError(error)) throw error;
    return buildTree(route.levels, params, createElement(MetadataError, { error }), options);
  }
  return buildTree(route.levels, params, withHead(head, leaf), options);
}

/**
 * The tree rendering the nearest notFound/forbidden/unauthorized boundary
 * above level `below` inside the route's layouts, and that boundary's level.
 */
async function fallbackTree(match, url, status, below, caught) {
  const { route, params } = match;
  const key = HTTP_FALLBACK_FILE[status];
  let level = Math.min(below - 1, route.levels.length - 1);
  while (level > 0 && !route.levels[level][key]) level--;
  const file = route.levels[level][key];
  const mod = await load(file);
  const element = mod ? createElement(mod.default) : defaultFallback(status);
  const head = await headElements(route.levels, level, mod, params, url, { noindex: status === 404 });
  const tree = await buildTree(route.levels, params, null, {
    fallback: { level, element: withHead(head, element) },
    pathname: url.pathname,
    searchParams: url.searchParams,
    slotPathname: match.slotPathname,
    caught,
  });
  return { tree, level };
}

function payloadFor(tree, url, params, extra) {
  return {
    ...extra,
    tree: createElement(RedirectBoundary, null, tree),
    pathname: url.pathname,
    search: url.search,
    params,
  };
}

function rscOptions(errors, report, temporaryReferences, { quiet = false } = {}) {
  return {
    temporaryReferences,
    onError(error) {
      if (error && typeof error === "object" && typeof error.digest === "string") {
        errors.push(error);
        return error.digest;
      }
      errors.push(error);
      if (!quiet && !isNavigationError(error)) {
        console.error(error);
        report(error);
      }
      return undefined;
    },
  };
}

function rscResponse(stream, status, headers = {}) {
  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/x-component; charset=utf-8", Vary: "Accept, x-vinext-url", ...headers },
  });
}

function redirectResponse(info, isRsc) {
  if (isRsc) return new Response(null, { status: 200, headers: { "x-vinext-redirect": info.url } });
  return new Response(null, { status: info.status, headers: { Location: info.url } });
}

/**
 * Render a page. notFound()/forbidden()/unauthorized() thrown outside any
 * Suspense boundary re-renders with the nearest fallback boundary; if a
 * layout keeps throwing, each retry moves the boundary above it. Any other
 * error that fails the HTML shell re-renders with the nearest error.tsx (or
 * global-error.tsx) showing it, moving up the same way; the RSC payload
 * carries the error to the client's boundaries itself. After a server
 * action, `action` holds what the payload carries besides the page (its
 * return value or form state) and the call's temporary references.
 */
async function renderPage(url, isRsc, match, report, action = {}) {
  const params = match ? match.params : {};
  const levels = match ? match.route.levels : [root];
  let fallbackStatus = null;
  let below = Infinity;
  // The error boundary showing a render error ({ level, serverError }), and
  // whether the render's errors have been reported (retries render them again).
  let caught = null;
  let reported = false;
  for (;;) {
    let status = match ? 200 : 404;
    const rscErrors = [];
    try {
      let tree;
      if (fallbackStatus === null) {
        tree = match ? await routeTree(match, url, caught) : await notFoundTree(url, caught);
      } else {
        const fallback = await fallbackTree(match, url, fallbackStatus, below, caught);
        tree = fallback.tree;
        below = fallback.level;
        status = fallbackStatus;
      }
      if (caught) status = caught.level === -1 ? 500 : status;
      tree = await withGlobalError(tree, caught);
      const stream = renderToReadableStream(
        payloadFor(tree, url, params, match?.intercept ? { ...action.payload, interceptedFrom: match.slotPathname } : action.payload),
        rscOptions(rscErrors, report, action.temporaryReferences, { quiet: reported }),
      );
      const config = status === 200 && match && !caught ? await segmentConfigOf(match.route) : null;
      const isDynamic = () => Boolean(getRequestContext()?.dynamic);
      if (isRsc) {
        if (!config) return rscResponse(stream, status, status >= 400 ? { "Cache-Control": NO_STORE } : {});
        const { body, cacheControl } = await finalizeCacheControl(stream, config, isDynamic);
        return rscResponse(body, status, cacheControl ? { "Cache-Control": cacheControl } : {});
      }
      const ssr = await import.meta.viteRsc.loadModule("ssr", "index");
      const html = await ssr.renderHtml(stream, { formState: action.payload?.formState });
      if (!config) return htmlResponse(html, status, status >= 400 ? NO_STORE : null);
      const { body, cacheControl } = await finalizeCacheControl(html, config, isDynamic);
      return htmlResponse(body, status, cacheControl);
    } catch (error) {
      const redirect = redirectInfo(error);
      if (redirect) return redirectResponse(redirect, isRsc);
      const thrownStatus = httpFallbackStatus(error);
      if (thrownStatus === null) {
        const level = isRsc ? null : nextErrorBoundary(levels, caught ? caught.level : Infinity, Boolean(root.globalError));
        if (level === null) throw error;
        // A server component's error was reported as the RSC render failed; one thrown while rendering HTML was not.
        if (!reported && !rscErrors.some((e) => !isNavigationError(e))) report(error);
        reported = true;
        caught = { level, serverError: serverErrorOf(error) };
        continue;
      }
      // No layout left to render the fallback inside (the root layout threw).
      if (!match || (fallbackStatus !== null && below <= 0)) return bareFallbackResponse(thrownStatus);
      fallbackStatus = thrownStatus;
    }
  }
}

/** What an error boundary is told of an error the server caught: its message, and digest if it has one. */
function serverErrorOf(error) {
  const message = error instanceof Error ? error.message : String(error);
  const digest = error && typeof error === "object" && typeof error.digest === "string" ? error.digest : undefined;
  return digest === undefined ? { message } : { message, digest };
}

function bareFallbackResponse(status) {
  const text = status === 404 ? "This page could not be found." : status === 403 ? "Forbidden" : "Unauthorized";
  return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${status}</title></head><body><h1>${status}</h1><p>${text}</p></body></html>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": NO_STORE },
  });
}

function htmlResponse(stream, status, cacheControl) {
  const headers = { "Content-Type": "text/html; charset=utf-8" };
  if (cacheControl) headers["Cache-Control"] = cacheControl;
  return new Response(stream, { status, headers });
}

/** The route's layout modules (null where a level has none) and page module. */
function routeModules(route) {
  return Promise.all([...route.levels.map((l) => load(l.layout)), load(route.file)]);
}

/** The layouts above an intercepting page (the owner's, then its own) and the page. */
function interceptModules({ route, intercept, ownerIndex }) {
  const levels = [...route.levels.slice(0, ownerIndex + 1), ...intercept.levels];
  return Promise.all([...levels.map((l) => load(l.layout)), load(intercept.file)]);
}

/** The route's segment config, from its layouts and page. */
async function segmentConfigOf(route) {
  return resolveSegmentConfig(await routeModules(route));
}

// ISR caches pages under vinext start; vinext dev renders every request, as Next.js does.
const ISR_ENABLED = !import.meta.env.DEV;

/**
 * A GET page render, answered from the ISR cache when the page has a finite
 * revalidate. Each render (and background regeneration) gets its own request
 * context, so the tags it used are known.
 */
function renderPageCached(request, url, isRsc, match, report) {
  if (!ISR_ENABLED || !match || request.method !== "GET") return renderPage(url, isRsc, match, report);
  // Pages may read searchParams, so each query string is its own entry.
  return serveWithIsr(`${isRsc ? "rsc" : "html"}:${url.pathname}${url.search}`, url.pathname, () => {
    const ctx = createRequestContext(request, { phase: "render" });
    return runWithRequestContext(ctx, async () => {
      const response = await renderPage(url, isRsc, match, report);
      return { response: scheduleAfter(ctx, response), tags: [...(ctx.cacheTags || [])] };
    });
  });
}

const rscDecoders = { createTemporaryReferenceSet, decodeReply, decodeAction, decodeFormState, loadServerAction };

/**
 * Answer a POST that runs a server action. A client call gets an RSC payload
 * with the action's return value, and the page re-rendered when the action
 * revalidated or wrote cookies, or an x-vinext-redirect header for redirect();
 * a form post gets the page (with the useActionState form state) or a 303.
 */
async function handleAction(ctx, url, isRsc, match, report) {
  const result = await runServerAction(ctx, rscDecoders);
  const rerender = endActionPhase(ctx);
  if (result.kind === "fetch") {
    if (result.notFound) return new Response("Server action not found.", { status: 404, headers: { "Content-Type": "text/plain" } });
    if (result.redirect) {
      return new Response(null, {
        status: 200,
        headers: { "x-vinext-redirect": result.redirect.url, "x-vinext-redirect-type": result.redirect.type },
      });
    }
    if (!result.returnValue.ok) console.error(result.returnValue.data);
    const payload = { returnValue: result.returnValue };
    const { temporaryReferences } = result;
    if (!rerender) return rscResponse(renderToReadableStream(payload, rscOptions([], report, temporaryReferences)), 200);
    return renderPage(url, true, match, report, { payload, temporaryReferences });
  }
  if (result.redirect) return new Response(null, { status: 303, headers: { Location: result.redirect.url } });
  return renderPage(url, isRsc, match, report, { payload: { formState: result.formState } });
}

async function handleMetadataRoute(request, match) {
  try {
    return await metadataRouteResponse(await load(match.route.file), match);
  } catch (error) {
    console.error(error);
    reportRequestError(error, request, match.route, "route");
    return new Response("Internal Server Error", { status: 500, headers: { "Content-Type": "text/plain" } });
  }
}

async function handleRoute(request, match) {
  const mod = await load(match.route.file);
  const onError = (error) => reportRequestError(error, request, match.route, "route");
  return callRouteHandler(mod, request, match.params, { file: match.route.file, onError });
}

/** "static" or "dynamic" for the app/ route a page pathname matches, else null. */
export function routeKind(pathname) {
  const match = matchAppRoute(routes, pathname);
  return match ? (match.route.isDynamic ? "dynamic" : "static") : null;
}

/** next.config's routing rules and the app's middleware, for the server's request pipeline. */
export { serverConfig };
export const loadMiddleware = middlewareLoader;

// instrumentation.ts: register() once per server process, before a request is answered.
const instrumentation = (globalThis[Symbol.for("vinext.instrumentation")] ??= createInstrumentation(loadInstrumentation));

export function instrumentationReady() {
  return instrumentation.ready();
}

function reportRequestError(error, request, route, routeType) {
  instrumentation.report(error, request, route, routeType);
}

/** The pathname of the client's x-vinext-url header, or null. */
function fromPathname(request) {
  const value = request.headers.get("x-vinext-url");
  if (!value || !value.startsWith("/") || value.startsWith("//")) return null;
  return value.split(/[?#]/)[0];
}

/** The fetch handler: a Request in, a Response out. */
export default async function handler(request) {
  const url = new URL(request.url);
  const { pathname, isRsc } = parseRscPath(url.pathname);
  const pageUrl = new URL(url);
  pageUrl.pathname = pathname;
  let match = matchAppRoute(routes, pathname);
  // A client navigation sends the URL it leaves (x-vinext-url), for intercepting
  // routes; a refresh or server action on an intercepted page sends the URL it intercepted from.
  const from = isRsc ? fromPathname(request) : null;
  const intercept = from ? matchIntercept(intercepts, routes, pathname, from) : null;
  if (intercept) match = { route: intercept.route, params: intercept.fromParams, intercept, slotPathname: from };
  if (match && (match.route.type === "route" || match.route.type === "metadata")) {
    if (isRsc) return new Response(null, { status: 200, headers: { "x-vinext-reload": "1" } });
    return match.route.type === "route" ? handleRoute(request, match) : handleMetadataRoute(request, match);
  }
  const isAction = actionRequestKind(request) !== null;
  const ctx = createRequestContext(request, { phase: isAction ? "action" : "render" });
  const report = (error) => reportRequestError(error, request, match?.route, isAction ? "action" : "render");
  const rsc = isRsc || request.headers.get("rsc") === "1";
  return runWithRequestContext(ctx, async () => {
    try {
      const response = isAction ? await handleAction(ctx, pageUrl, rsc, match, report) : await renderPageCached(request, pageUrl, rsc, match, report);
      return scheduleAfter(ctx, applyResponseCookies(ctx, response));
    } catch (error) {
      report(error);
      throw error;
    }
  });
}

if (import.meta.hot) import.meta.hot.accept();
