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

const ReactDOMServer = ReactDOMServerNS.renderToReadableStream ? ReactDOMServerNS : ReactDOMServerNS.default;

const routes = buildPagesRoutes(manifest.routeFiles);

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
    return { props: (await result.props) || {} };
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
  const headElements = [];
  const headManager = { add: (els) => headElements.push(...els) };
  const appHtml = await renderToString(createAppElement({ App, Component, pageProps, router, headManager }));
  const nextData = {
    props: { pageProps },
    page,
    query,
    buildId: opts.buildId,
    isFallback: false,
    ...extraData,
  };
  const headHTML =
    '<meta name="viewport" content="width=device-width"/>' + __headToHTML(headElements);
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
 * Handle a Node request for the Pages Router. Returns false when no page
 * route matched and the caller may try something else.
 */
export async function handlePagesRequest(req, res, opts) {
  const { url, pathname, isData, asPath } = parseRequest(req.url, opts.buildId);
  const match = matchPagesRoute(routes, pathname);
  const [appMod, documentMod] = await Promise.all([
    loadSpecial(manifest.loadApp),
    loadSpecial(manifest.loadDocument),
  ]);
  const App = appMod?.default || null;
  const Document = documentMod?.default || null;

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

  const result = await fetchPageProps({ mod, App, route, params, query, req, res, asPath, pathname });
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

  const pageProps = result.props;
  const dataFlags = {};
  if (mod.getServerSideProps) dataFlags.gssp = true;
  else if (mod.getStaticProps) dataFlags.gsp = true;
  else if (Component.getInitialProps) dataFlags.gip = true;

  if (isData) {
    sendJson(res, 200, { page: route.pattern, query, pageProps, ...dataFlags });
    return true;
  }

  const html = await renderPageHtml({
    App,
    Document,
    Component,
    pageProps,
    page: route.pattern,
    query,
    asPath,
    opts,
    extraData: dataFlags,
  });
  sendHtml(res, 200, html);
  return true;
}
