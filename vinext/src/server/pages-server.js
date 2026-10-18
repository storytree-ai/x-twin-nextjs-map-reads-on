/**
 * Pages Router request handling. Runs inside Vite (the dev server's SSR
 * module runner, or the SSR build), so app modules, shims and this file share
 * one module graph.
 */
import { createElement } from "react";
import * as ReactDOMServerNS from "react-dom/server";
import * as manifest from "virtual:vinext-pages-manifest";
import { buildPagesRoutes, matchPagesRoute, interpolatePattern } from "../routing/pages-routes.js";
import { createAppElement } from "../shared/app-element.js";
import { createRouter } from "../shims/router.js";
import { __headToHTML } from "../shims/head.js";
import { searchParamsToQuery } from "../shims/internal/url.js";
import DefaultDocument, { DocumentContext, MAIN_MARKER, HEAD_ID, SCRIPTS_ID } from "../shims/document.js";
import { handleApiRoute } from "./api-route.js";
import serverConfig from "virtual:vinext-server-config";
import { setConfig } from "../shims/config.js";
import { flushPreloads } from "../shims/dynamic.js";
import { runRequestPipeline, applyRewrites } from "./middleware-runner.js";
import { createUnifiedRequestContext, runWithUnifiedRequestContext } from "./render-context.js";

const ReactDOMServer = ReactDOMServerNS.renderToReadableStream ? ReactDOMServerNS : ReactDOMServerNS.default;

const routes = buildPagesRoutes(manifest.routeFiles);

setConfig({
  publicRuntimeConfig: serverConfig.publicRuntimeConfig || {},
  serverRuntimeConfig: serverConfig.serverRuntimeConfig || {},
});

// ISR: rendered getStaticProps pages with a revalidate time, by pathname.
const isrCache = (globalThis[Symbol.for("vinext.pagesIsrCache")] ??= new Map());

const DATA_PREFIX = "/_next/data/";

async function loadSpecial(loader) {
  return loader ? await loader() : null;
}

/** HTML-safe JSON for embedding in a script tag. */
function htmlSafeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

async function renderToString(element) {
  const stream = await ReactDOMServer.renderToReadableStream(element, {
    onError(error) {
      console.error(error);
    },
  });
  await stream.allReady;
  return await new Response(stream).text();
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function sendHtml(res, status, html) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

/** Resolve a request to its route, honoring the /_next/data/<buildId>/ form. */
function parseRequest(rawUrl, buildId) {
  const url = new URL(rawUrl, "http://localhost");
  let pathname = url.pathname;
  let isData = false;
  if (pathname.startsWith(DATA_PREFIX)) {
    const rest = pathname.slice(DATA_PREFIX.length);
    const slash = rest.indexOf("/");
    const id = slash === -1 ? rest : rest.slice(0, slash);
    if (id === buildId && rest.endsWith(".json")) {
      isData = true;
      pathname = rest.slice(slash, -".json".length);
      if (pathname === "/index") pathname = "/";
    }
  }
  return { url, pathname, isData, asPath: isData ? pathname + url.search : url.pathname + url.search };
}

async function checkStaticPaths(mod, route, params, pathname) {
  if (!mod.getStaticPaths || !route.isDynamic) return true;
  const result = await mod.getStaticPaths({ locales: undefined, defaultLocale: undefined });
  if (result.fallback !== false) return true;
  const normalize = (p) => {
    const trimmed = p.replace(/\/$/, "") || "/";
    try {
      return decodeURIComponent(trimmed);
    } catch {
      return trimmed;
    }
  };
  const target = normalize(pathname);
  for (const entry of result.paths || []) {
    const path =
      typeof entry === "string" ? entry : interpolatePattern(route.pattern, entry.params || {})?.path;
    if (path && normalize(path) === target) return true;
  }
  return false;
}

/**
 * Run the page's data fetching. Returns { props } | { redirect } | { notFound }.
 */
async function fetchPageProps({ mod, App, route, params, query, req, res, asPath, pathname }) {
  if (mod.getServerSideProps) {
    const result = await mod.getServerSideProps({
      params,
      query,
      req,
      res,
      resolvedUrl: asPath,
      locale: undefined,
      locales: undefined,
      defaultLocale: undefined,
    });
    if (!result) return { props: {} };
    if (result.redirect || result.notFound) return result;
    return { props: (await result.props) || {} };
  }
  if (mod.getStaticProps) {
    if (!(await checkStaticPaths(mod, route, params, pathname))) return { notFound: true };
    const result = await mod.getStaticProps({ params, locale: undefined, locales: undefined, defaultLocale: undefined });
    if (!result) return { props: {} };
    if (result.redirect || result.notFound) return result;
    return { props: (await result.props) || {}, revalidate: result.revalidate };
  }
  const Component = mod.default;
  const ctx = { req, res, pathname: route.pattern, query, asPath, AppTree: () => null };
  if (App && App.getInitialProps) {
    const router = createRouter({ pathname: route.pattern, query, asPath });
    const appProps = await App.getInitialProps({ Component, ctx, router, AppTree: () => null });
    return { props: appProps?.pageProps || {}, appProps };
  }
  if (Component && Component.getInitialProps) {
    return { props: (await Component.getInitialProps(ctx)) || {} };
  }
  return { props: {} };
}

function redirectTarget(redirect) {
  const status = redirect.statusCode || (redirect.permanent ? 308 : 307);
  return { destination: redirect.destination, status };
}

async function renderDocument({ Document, appHtml, headHTML, scripts }) {
  const Doc = Document || DefaultDocument;
  let docProps = {};
  if (Doc.getInitialProps) {
    const ctx = {
      renderPage: async () => ({ html: appHtml, head: [] }),
      defaultGetInitialProps: async () => ({ html: appHtml, head: [], styles: [] }),
    };
    docProps = (await Doc.getInitialProps(ctx)) || {};
  }
  let html = ReactDOMServer.renderToStaticMarkup(
    createElement(DocumentContext.Provider, { value: { headHTML, scripts } }, createElement(Doc, docProps)),
  );
  html = html.replace(MAIN_MARKER, appHtml);
  html = html.replace(`<noscript id="${HEAD_ID}"></noscript>`, headHTML);
  html = html.replace(`<script id="${SCRIPTS_ID}"></script>`, scripts);
  return "<!DOCTYPE html>" + html;
}

/**
 * Render a page to a full HTML document.
 */
async function renderPageHtml({ App, Document, Component, pageProps, page, query, asPath, opts, extraData }) {
  const router = createRouter({ pathname: page, route: page, query, asPath, isReady: true });
  const ctx = createUnifiedRequestContext();
  const headElements = ctx.ssrHeadChildren;
  const headManager = { add: (els) => headElements.push(...els) };
  await flushPreloads();
  const appHtml = await runWithUnifiedRequestContext(ctx, () =>
    renderToString(createAppElement({ App, Component, pageProps, router, headManager })),
  );
  const nextData = {
    props: { pageProps },
    page,
    query,
    buildId: opts.buildId,
    isFallback: false,
    ...extraData,
  };
  const runtimeConfig = serverConfig.publicRuntimeConfig || {};
  if (Object.keys(runtimeConfig).length) nextData.runtimeConfig = runtimeConfig;
  const inserted = ctx.serverInsertedHTMLCallbacks.map((cb) => cb() ?? "").join("");
  const headHTML =
    '<meta name="viewport" content="width=device-width"/>' + __headToHTML(headElements) + inserted;
  const scripts =
    `<script id="__NEXT_DATA__" type="application/json">${htmlSafeJson(nextData)}</script>` +
    `<script type="module" src="${opts.clientEntryUrl}"></script>`;
  let html = await renderDocument({ Document, appHtml, headHTML, scripts });
  if (opts.transformHtml) html = await opts.transformHtml(asPath, html);
  return html;
}

async function renderNotFound({ req, res, asPath, isData, opts, App, Document }) {
  if (isData) return sendJson(res, 404, { notFound: true });
  const mod = await loadSpecial(manifest.load404);
  const html = await renderPageHtml({
    App,
    Document,
    Component: mod.default,
    pageProps: manifest.has404 ? {} : { statusCode: 404 },
    page: "/404",
    query: {},
    asPath,
    opts,
  });
  return sendHtml(res, 404, html);
}

/** Whether a pages/ route answers the pathname (the App Router server asks first). */
export function hasPagesRoute(pathname) {
  return matchPagesRoute(routes, pathname) !== null;
}

/**
 * Route a request through next.config and middleware to a page: the
 * filesystem is matched after beforeFiles rewrites (static pages first),
 * then afterFiles, then dynamic pages, then fallback rewrites. Returns
 * { url, match } or null once the pipeline has answered.
 */
async function routeRequest(req, res, { url, pathname, isData }) {
  let request = await runRequestPipeline(req, res, {
    pathname,
    search: url.search,
    isData,
    config: serverConfig,
    loadMiddleware: manifest.loadMiddleware,
  });
  if (!request) return null;
  let match = matchPagesRoute(routes, request.url.pathname);
  if (match && !match.route.isDynamic) return { url: request.url, match };
  for (const phase of ["afterFiles", "fallback"]) {
    if (phase === "fallback" && match) break;
    const rewritten = await applyRewrites(req, res, serverConfig.rewrites?.[phase], request);
    if (rewritten === false) return null;
    if (rewritten) {
      request = rewritten;
      match = matchPagesRoute(routes, request.url.pathname);
      break;
    }
  }
  return { url: request.url, match };
}

/** Cache headers and the ISR cache for a getStaticProps page with revalidate. */
function setIsrHeaders(res, revalidate, state) {
  res.setHeader("Cache-Control", `s-maxage=${revalidate}, stale-while-revalidate`);
  res.setHeader("x-vinext-cache", state);
}

function isrSeconds(revalidate) {
  return typeof revalidate === "number" && revalidate > 0 ? revalidate : null;
}

/**
 * Handle a Node request for the Pages Router. Returns false when no page
 * route matched and the caller may try something else.
 */
export async function handlePagesRequest(req, res, opts) {
  const parsed = parseRequest(req.url, opts.buildId);
  const { isData, asPath } = parsed;
  const [appMod, documentMod] = await Promise.all([
    loadSpecial(manifest.loadApp),
    loadSpecial(manifest.loadDocument),
  ]);
  const App = appMod?.default || null;
  const Document = documentMod?.default || null;

  const routed = await routeRequest(req, res, parsed);
  if (!routed) return true;
  const { url, match } = routed;
  const pathname = url.pathname;

  if (!match || (isData && match.route.isApi)) {
    await renderNotFound({ req, res, asPath, isData, opts, App, Document });
    return true;
  }

  const { route, params } = match;
  const mod = await manifest.loaders[route.file]();
  const query = { ...searchParamsToQuery(url.searchParams), ...params };

  if (route.isApi) {
    await handleApiRoute(mod, req, res, query);
    return true;
  }

  const Component = mod.default;
  if (typeof Component !== "function" && typeof Component !== "object") {
    throw new Error(`The default export of pages/${route.file} is not a React component.`);
  }

  const dataFlags = {};
  if (mod.getServerSideProps) dataFlags.gssp = true;
  else if (mod.getStaticProps) dataFlags.gsp = true;
  else if (Component.getInitialProps) dataFlags.gip = true;

  const isStatic = !mod.getServerSideProps && !!mod.getStaticProps;

  /** Data fetching plus, for HTML (or the ISR cache), the document: { result, html }. */
  const generate = async ({ background = false } = {}) => {
    const result = await fetchPageProps({ mod, App, route, params, query, req, res, asPath, pathname });
    if ((!background && res.writableEnded) || result.redirect || result.notFound || (isData && !isStatic)) return { result };
    const html = await renderPageHtml({
      App,
      Document,
      Component,
      pageProps: result.props,
      page: route.pattern,
      query,
      asPath,
      opts,
      extraData: dataFlags,
    });
    return { result, html };
  };

  const send = ({ result, html }) => {
    if (isData) sendJson(res, 200, { page: route.pattern, query, pageProps: result.props, ...dataFlags });
    else sendHtml(res, 200, html);
  };

  const cached = isStatic ? isrCache.get(pathname) : undefined;
  if (cached) {
    const fresh = Date.now() < cached.expiresAt;
    setIsrHeaders(res, cached.revalidate, fresh ? "HIT" : "STALE");
    if (!fresh && !cached.regenerating) {
      cached.regenerating = true;
      generate({ background: true })
        .then((entry) => {
          const seconds = isrSeconds(entry.result.revalidate);
          if (entry.html && seconds) isrCache.set(pathname, { ...entry, revalidate: seconds, expiresAt: Date.now() + seconds * 1000 });
          else isrCache.delete(pathname);
        })
        .catch((err) => {
          console.error(err);
          cached.regenerating = false;
        });
    }
    send(cached);
    return true;
  }

  const entry = await generate();
  const { result } = entry;
  if (res.writableEnded) return true;

  if (result.redirect) {
    const { destination, status } = redirectTarget(result.redirect);
    if (isData) return sendJson(res, 200, { redirect: { destination, status } }), true;
    res.statusCode = status;
    res.setHeader("Location", destination);
    res.end();
    return true;
  }
  if (result.notFound) {
    await renderNotFound({ req, res, asPath, isData, opts, App, Document });
    return true;
  }

  const seconds = isStatic ? isrSeconds(result.revalidate) : null;
  if (seconds) {
    isrCache.set(pathname, { ...entry, revalidate: seconds, expiresAt: Date.now() + seconds * 1000 });
    setIsrHeaders(res, seconds, "MISS");
  }
  send(entry);
  return true;
}
