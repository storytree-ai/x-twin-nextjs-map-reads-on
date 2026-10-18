/**
 * Browser entry for the Pages Router: hydrates the server-rendered page and
 * runs client navigation (data from /_next/data/<buildId>/<path>.json).
 */
import { createElement, useSyncExternalStore } from "react";
import { hydrateRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import * as manifest from "virtual:vinext-pages-manifest";
import { fileToPattern } from "../routing/pages-routes.js";
import { createAppElement } from "../shared/app-element.js";
import Router, { createRouter, __setRouterState, __setNavigate, __getBeforePopState, __events } from "../shims/router.js";

const data = JSON.parse(document.getElementById("__NEXT_DATA__").textContent);
window.__NEXT_DATA__ = data;

const pageLoaders = {};
for (const file of manifest.routeFiles) pageLoaders[fileToPattern(file)] = manifest.loaders[file];

async function loadPageComponent(page) {
  const loader = page === "/404" || page === "/_error" ? manifest.load404 : pageLoaders[page];
  if (!loader) return null;
  return (await loader()).default;
}

function currentAsPath() {
  return window.location.pathname + window.location.search;
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
  return createAppElement({ App: s.App, Component: s.Component, pageProps: s.pageProps, router: s.router });
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
async function navigate(method, href, asPath, options) {
  const target = new URL(asPath, window.location.href);
  if (target.origin !== window.location.origin) {
    window.location.href = target.href;
    return false;
  }
  const id = ++navigationId;
  const shallow = !!options.shallow;
  __events.emit("routeChangeStart", asPath, { shallow });

  let page = appState.router.pathname;
  let pageProps = appState.pageProps;
  let query;
  let Component = appState.Component;
  try {
    const sameRoute = shallow && new URL(href, window.location.href).pathname === window.location.pathname;
    if (sameRoute) {
      query = { ...Object.fromEntries(new URL(href, window.location.href).searchParams), ...routeParams() };
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
        query = json.query;
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

  if (method) {
    window.history[method]({ __N: true, url: href, as: asPath, options: { shallow, scroll: options.scroll } }, "", asPath);
  }
  __events.emit("beforeHistoryChange", asPath, { shallow });
  const router = routerFor(page, query, asPath);
  flushSync(() => setAppState({ ...appState, Component, pageProps, router }));
  scrollAfterNavigation(asPath, options.scroll);
  __events.emit("routeChangeComplete", asPath, { shallow });
  return true;
}

function routeParams() {
  const q = appState.router.query || {};
  const params = {};
  const names = (appState.router.pathname.match(/\[(?:\.\.\.)?([^\]]+)\]/g) || []).map((s) =>
    s.replace(/[[\].]/g, ""),
  );
  for (const n of names) if (n in q) params[n] = q[n];
  return params;
}

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
  const asPath = currentAsPath();
  const router = routerFor(data.page, data.query || {}, asPath);
  appState = { App: appMod?.default || null, Component, pageProps: data.props.pageProps, router };
  window.history.replaceState({ __N: true, url: asPath, as: asPath, options: {} }, "", asPath);
  __setNavigate(navigate);
  window.next = { router: Router, version: "vinext" };
  hydrateRoot(document.getElementById("__next"), createElement(Root));
}

hydrate();
