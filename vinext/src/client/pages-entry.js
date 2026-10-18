/**
 * Browser entry for the Pages Router: hydrates the server-rendered page and
 * runs client navigation (data from /_next/data/<buildId>/<path>.json).
 */
import { createElement, useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { hydrateRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import * as manifest from "virtual:vinext-pages-manifest";
import { fileToPattern } from "../routing/pages-routes.js";
import { createAppElement } from "../shared/app-element.js";
import Router, { createRouter, __setRouterState, __setNavigate, __getBeforePopState, __events } from "../shims/router.js";
import { searchParamsToQuery } from "../shims/internal/url.js";
import { setConfig } from "../shims/config.js";
import { flushPreloads } from "../shims/dynamic.js";

const data = JSON.parse(document.getElementById("__NEXT_DATA__").textContent);
window.__NEXT_DATA__ = data;
setConfig({ publicRuntimeConfig: data.runtimeConfig || {}, serverRuntimeConfig: {} });

const pageLoaders = {};
for (const file of manifest.routeFiles) pageLoaders[fileToPattern(file)] = manifest.loaders[file];

async function loadPageComponent(page) {
  const loader = page === "/404" || page === "/_error" ? manifest.load404 : pageLoaders[page];
  if (!loader) return null;
  const Component = (await loader()).default;
  await flushPreloads();
  return Component;
}

function currentAsPath() {
  return window.location.pathname + window.location.search + window.location.hash;
}

function pathOf(url) {
  return url.pathname + url.search + url.hash;
}

let appState;
const listeners = new Set();
function setAppState(next) {
  appState = next;
  for (const l of listeners) l();
}
function subscribe(l) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function Root() {
  const s = useSyncExternalStore(subscribe, () => appState, () => appState);
  // Runs in the commit, before the previous page's passive effect cleanups,
  // so its router.events listeners still hear routeChangeComplete.
  useLayoutEffect(() => {
    const done = s.onCommit;
    if (done) {
      s.onCommit = null;
      done();
    }
  }, [s]);
  // The server saw no fragment, and a static page only its route params:
  // once hydrated, the router takes in the hash and the search params.
  useEffect(() => {
    const r = appState.router;
    const query =
      data.gsp && window.location.search
        ? queryFor(r.pathname, new URLSearchParams(window.location.search), r.query)
        : r.query;
    if (query !== r.query || window.location.hash) {
      setAppState({ ...appState, router: routerFor(r.pathname, query, currentAsPath()), onCommit: null });
    }
  }, []);
  return createAppElement({ App: s.App, Component: s.Component, pageProps: s.pageProps, router: s.router });
}

/** Commit new app state; onCommit runs inside the commit. */
function commit(next, onCommit = null) {
  flushSync(() => setAppState({ ...appState, ...next, onCommit }));
}

/** The query for a route: search params, with the route's own params winning. */
function queryFor(page, searchParams, routeQuery) {
  const query = searchParamsToQuery(searchParams);
  for (const name of paramNames(page)) {
    if (routeQuery && name in routeQuery) query[name] = routeQuery[name];
  }
  return query;
}

function paramNames(page) {
  return (page.match(/\[(?:\.\.\.)?([^\]]+)\]/g) || []).map((s) => s.replace(/[[\].]/g, ""));
}

/** Next.js's onlyAHashChange: same URL apart from the fragment. */
function onlyAHashChange(oldAs, newAs) {
  const [oldUrl, oldHash] = oldAs.split("#");
  const [newUrl, newHash] = newAs.split("#");
  if (newHash && oldUrl === newUrl && oldHash === newHash) return true;
  if (oldUrl !== newUrl) return false;
  return oldHash !== newHash;
}

function routerFor(page, query, asPath) {
  const snapshot = { pathname: page, route: page, query, asPath, isReady: true, isFallback: false };
  __setRouterState(snapshot);
  return createRouter(snapshot);
}

function dataUrl(href) {
  const url = new URL(href, window.location.href);
  const path = url.pathname === "/" ? "/index" : url.pathname.replace(/\/$/, "");
  return `/_next/data/${data.buildId}${path}.json${url.search}`;
}

function scrollAfterNavigation(asPath, scroll) {
  const hash = asPath.split("#")[1];
  if (hash) {
    const el = document.getElementById(decodeURIComponent(hash)) || document.getElementsByName(hash)[0];
    if (el) return el.scrollIntoView();
  }
  if (scroll !== false) window.scrollTo(0, 0);
}

let navigationId = 0;

/**
 * Navigate to href (the route URL) showing asPath in the address bar.
 * method: "pushState" | "replaceState" | null (history already moved).
 */
async function navigate(method, rawHref, rawAs, options) {
  const target = new URL(rawAs, window.location.href);
  if (target.origin !== window.location.origin) {
    window.location.href = target.href;
    return false;
  }
  const asPath = pathOf(target);
  const href = pathOf(new URL(rawHref, window.location.href));
  const shallow = !!options.shallow;

  if (onlyAHashChange(appState.router.asPath, asPath)) {
    navigationId++;
    __events.emit("hashChangeStart", asPath, { shallow });
    if (method) {
      window.history[method]({ __N: true, url: href, as: asPath, options: { shallow, scroll: options.scroll } }, "", asPath);
    }
    const s = appState.router;
    commit({ router: routerFor(s.pathname, s.query, asPath) });
    scrollAfterNavigation(asPath, false);
    __events.emit("hashChangeComplete", asPath, { shallow });
    return true;
  }

  const id = ++navigationId;
  __events.emit("routeChangeStart", asPath, { shallow });

  let page = appState.router.pathname;
  let pageProps = appState.pageProps;
  let query;
  let Component = appState.Component;
  try {
    const sameRoute = shallow && new URL(href, window.location.href).pathname === window.location.pathname;
    if (sameRoute) {
      query = queryFor(page, new URL(href, window.location.href).searchParams, appState.router.query);
    } else {
      const res = await fetch(dataUrl(href), { headers: { "x-nextjs-data": "1" } });
      if (!res.ok && res.status !== 404) throw new Error(`Failed to load ${href}: ${res.status}`);
      const json = await res.json();
      if (json.redirect) {
        const dest = json.redirect.destination;
        if (/^https?:\/\//.test(dest) && new URL(dest).origin !== window.location.origin) {
          window.location.href = dest;
          return false;
        }
        return navigate(method, dest, dest, options);
      }
      if (json.notFound) {
        page = "/404";
        query = {};
        pageProps = {};
      } else {
        page = json.page;
        // Static pages' data carries only route params; the URL adds the rest.
        query = json.gsp ? queryFor(page, new URL(href, window.location.href).searchParams, json.query) : json.query;
        pageProps = json.pageProps;
      }
      Component = await loadPageComponent(page);
      if (!Component) throw new Error(`No page for ${page}`);
    }
  } catch (err) {
    if (id !== navigationId) return false;
    __events.emit("routeChangeError", err, asPath, { shallow });
    window.location.href = asPath;
    return false;
  }
  if (id !== navigationId) {
    __events.emit("routeChangeError", Object.assign(new Error("Route Cancelled"), { cancelled: true }), asPath, { shallow });
    return false;
  }

  __events.emit("beforeHistoryChange", asPath, { shallow });
  if (method) {
    window.history[method]({ __N: true, url: href, as: asPath, options: { shallow, scroll: options.scroll } }, "", asPath);
  }
  const router = routerFor(page, query, asPath);
  window.__NEXT_DATA__ = { ...window.__NEXT_DATA__, page, query, props: { ...window.__NEXT_DATA__?.props, pageProps } };
  commit({ Component, pageProps, router }, () => {
    scrollAfterNavigation(asPath, options.scroll);
    __events.emit("routeChangeComplete", asPath, { shallow });
  });
  return true;
}

// history.pushState/replaceState done by hand, announced with "vinext:navigate":
// re-read the router from the address bar and __NEXT_DATA__.
window.addEventListener("vinext:navigate", () => {
  const nextData = window.__NEXT_DATA__ || data;
  const page = nextData.page || appState.router.pathname;
  const query = queryFor(page, new URLSearchParams(window.location.search), nextData.query);
  commit({ router: routerFor(page, query, currentAsPath()) });
});

window.addEventListener("popstate", (event) => {
  const state = event.state;
  if (!state || !state.__N) return;
  const cb = __getBeforePopState();
  if (cb && cb({ url: state.url, as: state.as, options: state.options || {} }) === false) return;
  navigate(null, state.url, state.as, state.options || {});
});

async function hydrate() {
  const [appMod, Component] = await Promise.all([
    manifest.loadApp ? manifest.loadApp() : null,
    loadPageComponent(data.page),
  ]);
  // _app's own dynamic() imports start when it loads; wait for them too.
  await flushPreloads();
  const asPath = currentAsPath();
  const router = routerFor(data.page, data.query || {}, asPath.split("#")[0]);
  appState = { App: appMod?.default || null, Component, pageProps: data.props.pageProps, router };
  window.history.replaceState({ __N: true, url: asPath, as: asPath, options: {} }, "", asPath);
  __setNavigate(navigate);
  window.next = { router: Router, version: "vinext" };
  hydrateRoot(document.getElementById("__next"), createElement(Root));
}

hydrate();
